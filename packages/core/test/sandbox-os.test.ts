import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectSandbox } from '../src/sandbox/index.ts';
import { execCommand } from '../src/tools/shell.ts';
import { tempProject } from './helpers.ts';

// Реальная проверка песочницы ОС: выполняется там, где она есть (macOS Seatbelt, Linux с bwrap).
const sandbox = detectSandbox();
const skip = sandbox.kind === 'none' ? 'на этой системе нет песочницы ОС' : false;

test(`песочница ${sandbox.kind}: запись внутри проекта разрешена, снаружи запрещена`, { skip }, async () => {
  const dir = tempProject({ 'a.txt': 'x' });
  const outside = join(homedir(), `.gemmacode-sandbox-probe-${process.pid}`);
  try {
    const inside = await execCommand('echo ok > inside.txt && cat inside.txt', { cwd: dir, sandbox });
    assert.equal(inside.exitCode, 0, inside.output);
    assert.equal(readFileSync(join(dir, 'inside.txt'), 'utf8').trim(), 'ok');

    const out = await execCommand(`echo leak > "${outside}"`, { cwd: dir, sandbox });
    assert.notEqual(out.exitCode, 0, 'запись в домашний каталог должна быть запрещена');
    assert.ok(!existsSync(outside));

    const tmp = await execCommand('echo t > "$(mktemp)"', { cwd: dir, sandbox });
    assert.equal(tmp.exitCode, 0, `запись во временный каталог должна работать: ${tmp.output}`);
  } finally {
    rmSync(outside, { force: true });
  }
});

test(`песочница ${sandbox.kind}: сеть выключена по умолчанию`, { skip }, async () => {
  const dir = tempProject();
  const probe = "node -e \"fetch('http://example.com').then(()=>process.exit(0),()=>process.exit(7))\"";
  const r = await execCommand(probe, { cwd: dir, sandbox, timeoutS: 20 });
  assert.equal(r.exitCode, 7, `ожидали отказ сети, получили ${r.exitCode}: ${r.output}`);
});

test(`песочница ${sandbox.kind}: секреты в домашнем каталоге нечитаемы`, { skip }, async () => {
  const dir = tempProject();
  const sshDir = join(homedir(), '.ssh');
  if (!existsSync(sshDir)) return;
  const r = await execCommand(`ls "${sshDir}"`, { cwd: dir, sandbox });
  assert.notEqual(r.exitCode, 0, 'чтение ~/.ssh должно быть запрещено');
});

test(`песочница ${sandbox.kind}: обычные инструменты разработки работают (git, node, npm --version)`, { skip }, async () => {
  const dir = tempProject({ 'package.json': '{"type":"module"}', 'test/a.test.js': "import {test} from 'node:test'; test('t', () => {});\n" });
  const r = await execCommand('git init -q . && node --test && npm --version', { cwd: dir, sandbox, timeoutS: 60 });
  assert.equal(r.exitCode, 0, r.output);
});
