import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoSandbox } from '@gemmacode/core';
import { OracleBackend } from './oracle-backend.ts';
import { execCommand } from '@gemmacode/core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNTAX_CHECK, renderReport, runEval } from './runner.ts';
import { ALL_TASKS } from './tasks/index.ts';

test('конвейер оценки: «идеальная модель» решает все задачи без петли и ревью', async () => {
  const tasks = ALL_TASKS;
  const { results, summary } = await runEval({ backend: new OracleBackend(tasks), tasks, sandbox: new NoSandbox() });
  const failed = results.filter((r) => !r.passed);
  assert.deepEqual(failed.map((r) => `${r.id}: ${r.failure}`), []);
  assert.equal(summary.passed, 50);
  assert.equal(summary.bySuite.edit30?.passed, 30);
  assert.match(renderReport('oracle', {}, results, summary), /Гейт M1 \(20 из 30 на правку кода\): пройден/);
});

test('конвейер оценки: режим loop с видимыми тестами и ревью на «идеальной модели»', async () => {
  const tasks = ALL_TASKS.filter((t) => ['fix-last-n', 'gen-slugify', 'rename-function'].includes(t.id));
  const { results } = await runEval({ backend: new OracleBackend(tasks), tasks, sandbox: new NoSandbox(), loop: true, maxIterations: 2 });
  assert.ok(results.every((r) => r.passed), JSON.stringify(results.map((r) => [r.id, r.outcome, r.failure])));
  assert.ok(results.every((r) => r.outcome === 'verified'));
});

test('проверка синтаксиса для режима loop ловит ошибку в любом файле, а не только в первом', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-syntax-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src/z.js'), 'export class Z {\n  m() {}\n  }\n}\n');
  const bad = await execCommand(SYNTAX_CHECK, { cwd: dir, sandbox: new NoSandbox() });
  assert.notEqual(bad.exitCode, 0, bad.output);
  writeFileSync(join(dir, 'src/z.js'), 'export class Z {\n  m() {}\n}\n');
  const good = await execCommand(SYNTAX_CHECK, { cwd: dir, sandbox: new NoSandbox() });
  assert.equal(good.exitCode, 0, good.output);
});
