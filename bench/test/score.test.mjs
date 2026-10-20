import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTasks, score } from '../lib/toolcalls.mjs';

const task = (id) => loadTasks().find((t) => t.id === id);

test('набор содержит 100 задач с уникальными id', () => {
  const t = loadTasks();
  assert.equal(t.length, 100);
  assert.equal(new Set(t.map((x) => x.id)).size, 100);
});

test('верный вызов, неверный инструмент, битый JSON, лишний вызов', () => {
  assert.deepEqual(score(task('read-01'), { name: 'read_file', arguments: '{"path":"src/main.ts"}' }), { ok: true, reason: 'ok' });
  assert.equal(score(task('read-01'), { name: 'list_dir', arguments: '{"path":"."}' }).reason, 'wrong_tool');
  assert.equal(score(task('read-01'), { name: 'read_file', arguments: '{"path":' }).reason, 'bad_json');
  assert.equal(score(task('read-01'), { name: 'read_file', arguments: '{"path":"other.ts"}' }).reason, 'bad_args:path');
  assert.equal(score(task('read-01'), { name: null }).reason, 'no_call');
  assert.equal(score(task('notool-01'), { name: 'shell', arguments: '{}' }).reason, 'extra_call');
  assert.equal(score(task('notool-01'), { name: null }).ok, true);
});

test('регулярки и подстроки не зависят от регистра', () => {
  assert.equal(score(task('shell-01'), { name: 'shell', arguments: '{"command":"npm test"}' }).ok, true);
  assert.equal(score(task('grep-01'), { name: 'grep', arguments: '{"pattern":"handlerequest"}' }).ok, true);
  assert.equal(score(task('list-01'), { name: 'list_dir', arguments: '{"path":"./"}' }).ok, true);
});
