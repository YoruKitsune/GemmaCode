import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rssMB, swapUsedMB, thermalState } from './system.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Аргументы llama-server. Те же флаги собирает packages/core/src/inference/args.ts;
 * здесь они продублированы, чтобы стенд запускался на чистом Node без сборки.
 */
export function serverArgs(o) {
  const a = [];
  if (o.file) a.push('-m', o.file);
  else a.push('-hf', o.hfRepo, ...(o.hfFile ? ['-hff', o.hfFile] : []));
  if (!o.multimodal) a.push('--no-mmproj');
  a.push('--host', '127.0.0.1', '--port', String(o.port));
  a.push('-c', String(o.ctx), '-np', '1');
  a.push('-fa', 'on', '-ctk', o.kv, '-ctv', o.kv);
  a.push('--jinja', '--reasoning', o.thinking ? 'on' : 'off', '--no-webui');
  if (o.spec && o.spec !== 'none') a.push('--spec-type', o.spec);
  if (o.mediaPath) a.push('--media-path', o.mediaPath);
  a.push(...(o.extra ?? []));
  return a;
}

/**
 * Запускает llama-server, ждёт загрузки модели (первый запуск включает скачивание),
 * сэмплирует RSS процесса и после fn(ctx) останавливает сервер.
 */
export async function withServer(o, fn) {
  const logDir = join(o.outDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(join(logDir, `${o.tag}.log`));
  const args = serverArgs(o);
  console.log(`  $ ${o.bin} ${args.join(' ')}`);
  const swapBefore = await swapUsedMB();
  const proc = spawn(o.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  let exited = null;
  let lastLine = '';
  proc.stderr.on('data', (d) => {
    lastLine = d.toString().trim().split('\n').pop() ?? lastLine;
  });
  proc.on('exit', (code) => {
    exited = code ?? -1;
  });

  let rssPeak = 0;
  const sampler = setInterval(async () => {
    const r = await rssMB(proc.pid);
    if (r && r > rssPeak) rssPeak = r;
  }, 500);

  const baseUrl = `http://127.0.0.1:${o.port}`;
  const deadline = Date.now() + (o.loadTimeoutMin ?? 90) * 60_000;
  let lastReport = 0;
  try {
    for (;;) {
      if (exited !== null) throw new Error(`llama-server завершился (код ${exited}). Последняя строка: ${lastLine}. Лог: ${logDir}/${o.tag}.log`);
      if (Date.now() > deadline) throw new Error('модель не загрузилась за отведённое время');
      try {
        const r = await fetch(`${baseUrl}/health`);
        if (r.ok) break;
      } catch {
        // порт ещё не открыт
      }
      if (Date.now() - lastReport > 30_000) {
        lastReport = Date.now();
        console.log(`  ... загрузка: ${lastLine.slice(0, 120)}`);
      }
      await sleep(1000);
    }
    const props = await (await fetch(`${baseUrl}/props`)).json().catch(() => ({}));
    const ctx = { baseUrl, props, pid: proc.pid };
    const value = await fn(ctx);
    const meta = {
      rssPeakMB: Math.round(rssPeak),
      swapDeltaMB: (await swapUsedMB()) - (swapBefore ?? 0),
      thermal: await thermalState(),
      modelPath: props.model_path ?? props.model_alias ?? null,
    };
    return { value, meta };
  } finally {
    clearInterval(sampler);
    proc.kill('SIGTERM');
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(8000)]);
    if (exited === null) proc.kill('SIGKILL');
    log.end();
  }
}
