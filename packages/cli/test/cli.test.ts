import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCli } from '../src/args.ts';
import { runCommand, type ReplState } from '../src/commands.ts';
import { openSession } from '../src/session.ts';
import { formatEdit } from '../src/render.ts';
import { runTask } from '@gemmacode/core';
import { startFakeServer, type FakeTurn } from '../../core/test/fixtures/fake-openai-server.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gemmacode.mjs');

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gc-cli-'));
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), c);
  }
  return dir;
}

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'gc-home-')), NO_COLOR: '1', ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const edit = (path: string, o: string, n: string): FakeTurn => ({ call: { name: 'edit_file', args: { path, old_string: o, new_string: n } } });

test('разбор аргументов: режимы, сервер, ошибки', () => {
  const o = parseCli(['--mode', 'auto-edit', '--server-url', 'http://x:1', '--verify', 'npm test', '--review', '--max-iterations', '3', 'починить', 'тест']);
  assert.equal(o.mode, 'auto-edit');
  assert.equal(o.server.url, 'http://x:1');
  assert.equal(o.verify, 'npm test');
  assert.equal(o.review, true);
  assert.equal(o.maxIterations, 3);
  assert.equal(o.prompt, 'починить тест');
  assert.equal(parseCli(['--yolo']).mode, 'full');
  assert.equal(parseCli(['-p', 'x']).print, true);
  assert.throws(() => parseCli(['--mode', 'wild']), /--mode/);
  assert.throws(() => parseCli(['--context=-5']), /положительное/);
});

test('formatEdit показывает - и + строки', () => {
  assert.equal(formatEdit({ old_string: 'a\nb', new_string: 'c' }), '    - a\n    - b\n    + c');
});

test('-p: правка файла с --mode auto-edit, вывод хода, код 0', async () => {
  const dir = project({ 'a.txt': 'hello old' });
  const srv = await startFakeServer([edit('a.txt', 'old', 'new'), { text: 'Готово.' }]);
  try {
    const r = await cli(['-p', 'замени old', '--cwd', dir, '--server-url', srv.url, '--mode', 'auto-edit']);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'hello new');
    assert.match(r.out, /● edit_file edit a\.txt/);
    assert.match(r.out, /- old/);
    assert.match(r.out, /\+ new/);
    assert.match(r.out, /Готово\./);
  } finally {
    await srv.close();
  }
});

test('-p без терминала в режиме ask: подтверждение недоступно, правка отклонена', async () => {
  const dir = project({ 'a.txt': 'old' });
  const srv = await startFakeServer([edit('a.txt', 'old', 'new'), { text: 'не смог' }]);
  try {
    const r = await cli(['-p', 'замени', '--cwd', dir, '--server-url', srv.url]);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'old');
    assert.match(r.out, /запросить некого/);
    assert.match(r.err, /--mode auto-edit/);
  } finally {
    await srv.close();
  }
});

test('-p --verify: проверка падает, агент чинит, код 0; безнадёжный случай даёт код 1', async () => {
  const files = { 'math.js': 'export const add = (a, b) => a - b;\n', 'check.mjs': "import { add } from './math.js';\nif (add(2, 3) !== 5) process.exit(1);\n", 'package.json': '{"type":"module"}' };
  const dir = project(files);
  const srv = await startFakeServer([{ text: 'думаю, всё верно' }, edit('math.js', 'a - b', 'a + b'), { text: 'исправил' }]);
  try {
    const r = await cli(['-p', 'add должна складывать', '--cwd', dir, '--server-url', srv.url, '--mode', 'auto-edit', '--verify', 'node check.mjs']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /проверка node check\.mjs не прошла/);
    assert.match(r.out, /↻ попытка 2\/4/);
    assert.match(r.out, /проверка node check\.mjs прошла/);
  } finally {
    await srv.close();
  }
  const dir2 = project(files);
  const srv2 = await startFakeServer([{ text: 'ничего' }, { text: 'опять ничего' }]);
  try {
    const r = await cli(['-p', 'add', '--cwd', dir2, '--server-url', srv2.url, '--mode', 'auto-edit', '--verify', 'node check.mjs']);
    assert.equal(r.code, 1);
    assert.match(r.out, /правки не меняют результат/);
  } finally {
    await srv2.close();
  }
});

test('без настроенной модели — подсказка и код 2; --help работает без модели', async () => {
  const r = await cli(['-p', 'x', '--cwd', project({})]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Модель не настроена/);
  const h = await cli(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /--verify/);
});

test('--json: события построчно', async () => {
  const dir = project({ 'a.txt': 'x' });
  const srv = await startFakeServer([{ text: 'ответ' }]);
  try {
    const r = await cli(['-p', 'привет', '--cwd', dir, '--server-url', srv.url, '--json']);
    const events = r.out.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'text'));
    assert.equal(events.at(-1).type, 'run_done');
  } finally {
    await srv.close();
  }
});

test('команды: /undo откатывает файлы и историю, /diff, /mode, /verify, /review', async () => {
  const dir = project({ 'a.txt': 'one\n' });
  const srv = await startFakeServer([
    { call: { name: 'write_file', args: { path: 'a.txt', content: 'two\n' } } },
    { text: 'записал' },
    (body: any) => ({ text: String(body.messages.find((m: any) => m.role === 'user' && m.content.includes('Note:'))?.content.slice(0, 60)) }),
  ]);
  const home = mkdtempSync(join(tmpdir(), 'gc-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const s = await openSession({ prompt: '', print: false, json: false, cwd: dir, mode: 'auto-edit', server: { url: srv.url }, help: false }, undefined);
    const st: ReplState = { verify: undefined, review: false, maxIterations: 4 };
    for await (const _ of runTask(s.agent, 'перепиши a.txt')) void _;
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'two\n');
    assert.match(runCommand('/diff', s, st)!.output, /-one\n\+two/);
    assert.match(runCommand('/mode full', s, st)!.output, /full/);
    assert.equal(s.policy.mode, 'full');
    assert.match(runCommand('/verify npm test', s, st)!.output, /npm test/);
    assert.equal(st.verify, 'npm test');
    runCommand('/verify off', s, st);
    assert.equal(runCommand('/review on', s, st)!.output, 'Само-ревью: включено');
    assert.match(runCommand('/nonsense', s, st)!.output, /Неизвестная команда/);
    assert.equal(runCommand('привет', s, st), null);

    const undo = runCommand('/undo', s, st)!;
    assert.match(undo.output, /Откатил: a\.txt/);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(s.agent.messages.length, 0);
    for await (const _ of runTask(s.agent, 'что дальше?')) void _;
    const sent = srv.requests.at(-1).messages.find((m: any) => m.role === 'user').content as string;
    assert.match(sent, /^\[Note: The user reverted your last changes, these files were restored: a\.txt\.\]/);
    assert.equal(s.store.list().length, 1);
    assert.equal(s.store.load(s.agent.sessionId).length, 2);
    await s.close();
  } finally {
    process.env.HOME = prevHome;
    await srv.close();
  }
  assert.ok(existsSync(join(dir, '.gemmacode', 'sessions')));
});
