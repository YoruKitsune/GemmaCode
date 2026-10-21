import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadError, ModelDownloader, type ModelSpec, type Progress } from '../src/model-download.ts';

const SIZE = 3 * 2 ** 20 + 12345;
const BODY = randomBytes(SIZE);
const SPEC: ModelSpec = {
  id: 't',
  title: 't',
  repo: 'x/y',
  revision: 'abc123',
  license: 'Apache-2.0',
  files: [{ name: 'm.gguf', role: 'model', size: SIZE, sha256: createHash('sha256').update(BODY).digest('hex') }],
};

interface Opts {
  /** Оборвать соединение после стольких байт ответа (первые `cutTimes` запросов). */
  cutAfter?: number;
  cutTimes?: number;
  ignoreRange?: boolean;
  body?: Buffer;
  status?: number;
}

async function serve(o: Opts = {}): Promise<{ url: string; requests: { url: string; range?: string }[]; close(): Promise<void>; server: Server }> {
  const requests: { url: string; range?: string }[] = [];
  let cuts = 0;
  const body = o.body ?? BODY;
  const server = createServer((req: IncomingMessage, res) => {
    requests.push({ url: req.url ?? '', ...(req.headers.range ? { range: req.headers.range } : {}) });
    if (o.status) {
      res.writeHead(o.status);
      return void res.end('nope');
    }
    let start = 0;
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m && !o.ignoreRange) start = Number(m[1]);
    const chunk = body.subarray(start);
    if (start > 0) res.writeHead(206, { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, 'content-length': chunk.length });
    else res.writeHead(200, { 'content-length': chunk.length });
    if (o.cutAfter !== undefined && cuts < (o.cutTimes ?? 1)) {
      cuts++;
      res.write(chunk.subarray(0, o.cutAfter));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(chunk);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, server, close: () => new Promise((r) => server.close(() => r())) };
}

const dl = (dir: string, endpoint: string, extra: Partial<ConstructorParameters<typeof ModelDownloader>[0]> = {}) =>
  new ModelDownloader({ dir, endpoint, spec: SPEC, retryDelayMs: 10, spareBytes: 0, ...extra });
const tmp = () => mkdtempSync(join(tmpdir(), 'gc-dl-'));

test('загрузка: прогресс, хеш, метка готовности, адрес с закреплённым коммитом; потом работает без сети', async () => {
  const s = await serve();
  const dir = tmp();
  const seen: Progress[] = [];
  const d = dl(dir, s.url, { onProgress: (p) => seen.push(p) });
  assert.equal(d.status()[0]!.state, 'missing');
  const r = await d.download(['model']);
  assert.equal(r.model, join(dir, 'm.gguf'));
  assert.equal(r.mmproj, undefined);
  assert.equal(statSync(r.model!).size, SIZE);
  assert.equal(s.requests[0]!.url, '/x/y/resolve/abc123/m.gguf');
  assert.ok(seen.some((p) => p.phase === 'downloading') && seen.some((p) => p.phase === 'verifying') && seen.at(-1)!.phase === 'done');
  assert.equal(d.status()[0]!.state, 'ready');
  assert.equal(existsSync(join(dir, 'm.gguf.part')), false);
  await s.close();
  // сервера больше нет: повторный вызов ничего не качает и не падает
  const again = await dl(dir, s.url).download(['model']);
  assert.equal(again.model, r.model);
});

test('обрыв посреди файла: повтор продолжает с места обрыва через Range', async () => {
  const s = await serve({ cutAfter: 1_500_000 });
  const dir = tmp();
  const seen: Progress[] = [];
  await dl(dir, s.url, { onProgress: (p) => seen.push(p) }).download(['model']);
  await s.close();
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[0]!.range, undefined);
  const from = Number(/bytes=(\d+)-/.exec(s.requests[1]!.range ?? '')![1]);
  assert.ok(from > 0 && from <= 1_500_000, `продолжили с ${from}`);
  assert.deepEqual(readFileSync(join(dir, 'm.gguf')), BODY);
  assert.ok(seen.some((p) => p.attempt === 1));
});

test('остановка сохраняет .part, следующая загрузка продолжает, а не начинает заново', async () => {
  const s = await serve({ cutAfter: 1_000_000, cutTimes: 99 });
  const dir = tmp();
  const ctl = new AbortController();
  const d = dl(dir, s.url, { onProgress: (p) => p.received > 500_000 && ctl.abort() });
  await assert.rejects(d.download(['model'], ctl.signal), (e: DownloadError) => e.code === 'aborted');
  const part = statSync(join(dir, 'm.gguf.part')).size;
  assert.ok(part > 0 && part < SIZE);
  assert.equal(d.status()[0]!.state, 'partial');
  assert.equal(d.status()[0]!.bytes, part);
  await s.close();
  const s2 = await serve();
  await dl(dir, s2.url).download(['model']);
  assert.match(s2.requests[0]!.range ?? '', new RegExp(`^bytes=${part}-`));
  assert.deepEqual(readFileSync(join(dir, 'm.gguf')), BODY);
  await s2.close();
});

test('сервер игнорирует Range (200): файл перекачивается с начала и проходит проверку', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'm.gguf.part'), BODY.subarray(0, 100_000));
  const s = await serve({ ignoreRange: true });
  await dl(dir, s.url).download(['model']);
  await s.close();
  assert.deepEqual(readFileSync(join(dir, 'm.gguf')), BODY);
});

test('повреждённая загрузка: хеш не совпал, .part удалён, ошибка с кодом hash', async () => {
  const bad = Buffer.from(BODY);
  bad[1000] = bad[1000]! ^ 0xff;
  const s = await serve({ body: bad });
  const dir = tmp();
  await assert.rejects(dl(dir, s.url).download(['model']), (e: DownloadError) => e.code === 'hash' && /SHA-256/.test(e.message));
  await s.close();
  assert.equal(existsSync(join(dir, 'm.gguf.part')), false);
  assert.equal(existsSync(join(dir, 'm.gguf')), false);
});

test('уже лежащий вручную файл принимается по хешу, чужой с тем же именем не затирается', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'm.gguf'), BODY);
  assert.equal(dl(dir, 'http://127.0.0.1:1').status()[0]!.state, 'missing');
  await dl(dir, 'http://127.0.0.1:1').download(['model']); // без сети: хеш сошёлся
  assert.equal(dl(dir, 'http://127.0.0.1:1').status()[0]!.state, 'ready');

  const dir2 = tmp();
  writeFileSync(join(dir2, 'm.gguf'), 'чужой файл');
  await assert.rejects(dl(dir2, 'http://127.0.0.1:1').download(['model']), (e: DownloadError) => e.code === 'conflict');
  assert.equal(readFileSync(join(dir2, 'm.gguf'), 'utf8'), 'чужой файл');
});

test('ошибки сервера: 404 не повторяется, пять сотых повторяются и кончаются понятной ошибкой', async () => {
  const s404 = await serve({ status: 404 });
  await assert.rejects(dl(tmp(), s404.url).download(['model']), (e: DownloadError) => e.code === 'http' && /не найден/.test(e.message));
  assert.equal(s404.requests.length, 1);
  await s404.close();
  const s503 = await serve({ status: 503 });
  await assert.rejects(dl(tmp(), s503.url, { maxAttempts: 3 }).download(['model']), (e: DownloadError) => e.code === 'network' && /продолжится с места обрыва/.test(e.message));
  assert.equal(s503.requests.length, 3);
  await s503.close();
});

test('мало места: ошибка до начала загрузки', async () => {
  const d = dl(tmp(), 'http://127.0.0.1:1', { spareBytes: 2 ** 60 });
  await assert.rejects(d.download(['model']), (e: DownloadError) => e.code === 'disk' && /Не хватает места/.test(e.message));
});
