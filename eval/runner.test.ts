import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoSandbox } from '@gemmacode/core';
import { OracleBackend } from './oracle-backend.ts';
import { renderReport, runEval } from './runner.ts';
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
