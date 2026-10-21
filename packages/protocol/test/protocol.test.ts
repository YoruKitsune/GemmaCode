import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTurnEvent, diffStats, feedFromMessages, parseUnifiedDiff, type FeedItem, type StoredMessage, type TurnEvent } from '../src/index.ts';

test('лента из истории: пары вызов/результат, отказы, вложения', () => {
  const msgs: StoredMessage[] = [
    { role: 'user', content: 'сделай', checkpoint: 1, ui: { text: 'сделай', attachments: [{ name: 'a.png', kind: 'image', relPaths: ['.gemmacode/attachments/x/a.png'] }] } },
    { role: 'assistant', content: 'смотрю', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }, { id: 'c2', name: 'shell', arguments: '{"command":"rm -rf x"}' }] },
    { role: 'tool', toolCallId: 'c1', content: 'export {}' },
    { role: 'tool', toolCallId: 'c2', content: 'Denied: The user declined this action.' },
    { role: 'assistant', content: 'готово' },
  ];
  const feed = feedFromMessages(msgs);
  assert.deepEqual(feed.map((f) => f.kind), ['user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal((feed[0] as any).checkpoint, 1);
  assert.equal((feed[0] as any).attachments[0].name, 'a.png');
  assert.equal((feed[2] as any).status, 'ok');
  assert.equal((feed[2] as any).summary, 'read_file a.ts');
  assert.equal((feed[3] as any).status, 'denied');
});

test('лента из истории: служебные сообщения не показываются, сводка контекста — заметка', () => {
  const feed = feedFromMessages([
    { role: 'user', content: '[Context was compacted. Summary...]\nx' },
    { role: 'user', content: 'The check `npm test` failed (exit code 1). Output: ...' },
    { role: 'user', content: '[Note: The user reverted your last changes.]\n\nпривет' },
  ]);
  assert.deepEqual(feed.map((f) => f.kind), ['note', 'user']);
  assert.equal((feed[1] as any).text, 'привет');
});

test('живая лента: текст копится, вызовы закрывают поток, результат с diff', () => {
  const evs: TurnEvent[] = [
    { type: 'text', delta: 'Чит' },
    { type: 'text', delta: 'аю' },
    { type: 'tool_call', id: 't1', name: 'edit_file', summary: 'edit a.ts', args: { path: 'a.ts' } },
    { type: 'tool_result', id: 't1', name: 'edit_file', content: 'Edited a.ts', isError: false, touched: ['/p/a.ts'], ms: 12, diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y' },
    { type: 'text', delta: 'Готово' },
    { type: 'done', reason: 'completed', steps: 2 },
  ];
  let feed: FeedItem[] = [];
  for (const e of evs) feed = applyTurnEvent(feed, e);
  assert.deepEqual(feed.map((f) => f.kind), ['assistant', 'tool', 'assistant']);
  assert.equal((feed[0] as any).text, 'Читаю');
  assert.equal((feed[0] as any).streaming, false);
  assert.equal((feed[1] as any).status, 'ok');
  assert.match((feed[1] as any).diff, /^--- a\/a\.ts/);
  assert.equal((feed[2] as any).streaming, false);
});

test('отмена посреди вызова: вызов не остаётся «выполняется», появляется заметка', () => {
  let feed: FeedItem[] = [];
  feed = applyTurnEvent(feed, { type: 'tool_call', id: 't1', name: 'shell', summary: 'sleep 99', args: {} });
  feed = applyTurnEvent(feed, { type: 'done', reason: 'aborted', steps: 1 });
  assert.equal((feed[0] as any).status, 'error');
  assert.equal((feed[1] as any).text, 'Остановлено');
});

test('разбор unified diff: счётчики и номера строк', () => {
  const d = ['--- a/x.ts', '+++ b/x.ts', '@@ -2,3 +2,4 @@', ' a', '-b', '+B', '+B2', ' c', '@@ -10,1 +11,1 @@', '--- комментарий', '+новое'].join('\n');
  const [f] = parseUnifiedDiff(d);
  assert.equal(f!.oldPath, 'x.ts');
  assert.equal(f!.newPath, 'x.ts');
  assert.equal(f!.hunks.length, 2);
  assert.deepEqual(f!.hunks[0]!.lines.map((l) => [l.t, l.oldNo, l.newNo]), [[' ', 2, 2], ['-', 3, undefined], ['+', undefined, 3], ['+', undefined, 4], [' ', 4, 5]]);
  assert.equal(f!.hunks[1]!.lines[0]!.text, '-- комментарий');
  assert.deepEqual(diffStats(d), { added: 3, removed: 2, files: 1 });
});

test('разбор diff: несколько файлов и создание файла', () => {
  const d = ['--- /dev/null', '+++ b/n.txt', '@@ -1,0 +1,2 @@', '+a', '+b', '--- a/m.txt', '+++ /dev/null', '@@ -1,1 +1,0 @@', '-z'].join('\n');
  const files = parseUnifiedDiff(d);
  assert.equal(files.length, 2);
  assert.deepEqual(diffStats(d), { added: 2, removed: 1, files: 2 });
});
