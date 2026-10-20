import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TASKS, SUITES } from './tasks/index.ts';
import { materialize, verifyTask, writeFiles } from './materialize.ts';
import { NoSandbox } from '@gemmacode/core';

test('набор: 30 задач на правку и 20 на генерацию, id уникальны', () => {
  assert.equal(SUITES.edit30.length, 30);
  assert.equal(SUITES.gen20.length, 20);
  assert.equal(new Set(ALL_TASKS.map((t) => t.id)).size, ALL_TASKS.length);
  for (const t of ALL_TASKS) {
    assert.ok(t.prompt.length > 20, t.id);
    assert.ok(Object.keys(t.tests).length > 0, t.id);
    assert.ok(Object.keys(t.solution).length > 0, t.id);
  }
});

// Самопроверка набора: без решения проверка падает, с эталонным решением проходит.
for (const task of ALL_TASKS) {
  test(`задача ${task.id}: исходное состояние падает, эталонное решение проходит`, async () => {
    const sandbox = new NoSandbox();
    const dir = materialize(task);
    const before = await verifyTask(task, dir, sandbox);
    assert.equal(before.passed, false, `проверка не должна проходить без решения:\n${before.output}`);
    writeFiles(dir, task.solution);
    const after = await verifyTask(task, dir, sandbox);
    assert.equal(after.passed, true, `эталонное решение не проходит:\n${after.output}`);
  });
}
