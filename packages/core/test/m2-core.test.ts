import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, withoutOldMedia } from '../src/agent/loop.ts';
import type { AgentEvent, ApprovalRequest } from '../src/agent/events.ts';
import type { ChatMessage } from '../src/inference/backend.ts';
import { PermissionPolicy, type PermissionMode } from '../src/permissions/policy.ts';
import { createRegistry } from '../src/tools/registry.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { SessionStore } from '../src/session/store.ts';
import { NoSandbox } from '../src/sandbox/index.ts';
import { ScriptedBackend, tempProject, type Scripted } from './helpers.ts';

function mk(dir: string, script: Scripted[], opts: { mode?: PermissionMode; approve?: (r: ApprovalRequest) => Promise<'allow' | 'deny'>; sessionId?: string } = {}) {
  const sessionId = opts.sessionId ?? SessionStore.newId();
  const store = new SessionStore(dir);
  const snapshots = new SnapshotStore(dir, sessionId);
  const backend = new ScriptedBackend(script);
  const agent = new Agent({
    backend, cwd: dir, registry: createRegistry('edit'), sandbox: new NoSandbox(), sessionId, store, snapshots,
    policy: new PermissionPolicy({ mode: opts.mode ?? 'auto-edit', cwd: dir, sandboxEnforced: true }),
    ...(opts.approve ? { approve: opts.approve } : {}),
  });
  return { agent, backend, snapshots, store, sessionId };
}

async function run(agent: Agent, input: Parameters<Agent['send']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.send(input)) out.push(e);
  return out;
}

test('tool_result несёт diff правки, а запрос подтверждения — предпросмотр diff до записи', async () => {
  const dir = tempProject({ 'a.txt': 'one\ntwo\nthree\n' });
  let asked: ApprovalRequest | undefined;
  const { agent } = mk(dir, [
    { calls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'two', new_string: '2' } }] },
    { text: 'ok' },
  ], { mode: 'ask', approve: async (r) => { asked = r; assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n', 'до подтверждения файл не тронут'); return 'allow'; } });
  const ev = await run(agent, 'правь');
  assert.match(asked?.diff ?? '', /-two\n\+2/);
  const res = ev.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
  assert.match(res.diff ?? '', /--- a\/a\.txt\n\+\+\+ b\/a\.txt/);
  assert.match(res.diff ?? '', /-two\n\+2/);
});

test('write_file нового файла: diff от /dev/null', async () => {
  const dir = tempProject();
  const { agent } = mk(dir, [{ calls: [{ name: 'write_file', args: { path: 'n.txt', content: 'hi\n' } }] }, { text: 'ok' }]);
  const ev = await run(agent, 'создай');
  const res = ev.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
  assert.match(res.diff ?? '', /--- \/dev\/null\n\+\+\+ b\/n\.txt\n@@ -1,0 \+1,1 @@\n\+hi/);
});

test('откат к контрольной точке: файлы и история возвращаются к началу хода', async () => {
  const dir = tempProject({ 'a.txt': 'v0\n' });
  const { agent, store, sessionId } = mk(dir, [
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'v1\n' } }] }, { text: 'первый ход' },
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'v2\n' } }, ] }, { text: 'второй ход' },
  ]);
  await run(agent, 'ход один');
  await run(agent, 'ход два');
  const cps = agent.messages.filter((m) => m.role === 'user').map((m) => (m as any).checkpoint);
  assert.deepEqual(cps, [1, 2]);
  const r = agent.rollbackTo(2);
  assert.deepEqual(r, { files: ['a.txt'], historyTrimmed: true });
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'v1\n');
  assert.equal(agent.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(store.load(sessionId).filter((m) => m.role === 'user').length, 1, 'история на диске обрезана');
  agent.rollbackTo(1);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'v0\n');
  assert.equal(agent.messages.length, 0);
});

test('откат после сжатия контекста: файлы возвращаются, модели уходит пометка', async () => {
  const dir = tempProject({ 'a.txt': 'v0\n' });
  const { agent } = mk(dir, [
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'v1\n' } }] }, { text: 'ok' },
    { text: 'после отката' },
  ]);
  await run(agent, 'ход');
  agent.messages.splice(0, agent.messages.length, { role: 'user', content: '[Context was compacted] ...' });
  const r = agent.rollbackTo(1);
  assert.deepEqual(r, { files: ['a.txt'], historyTrimmed: false });
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'v0\n');
  const { backend } = { backend: (agent as any).o.backend as ScriptedBackend };
  await run(agent, 'дальше');
  const last = backend.requests.at(-1)!.messages.filter((m) => m.role === 'user').at(-1)!.content as string;
  assert.match(last, /reverted your changes.*a\.txt/);
});

test('checkpointChanges: изменения одного хода', async () => {
  const dir = tempProject({ 'a.txt': 'v0\n' });
  const { agent, snapshots } = mk(dir, [
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'v1\n' } }] }, { text: 'ok' },
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'v2\n' } }, { name: 'write_file', args: { path: 'b.txt', content: 'b\n' } }] }, { text: 'ok' },
  ]);
  await run(agent, 'один');
  await run(agent, 'два');
  const c1 = snapshots.checkpointChanges(1);
  assert.deepEqual(c1.map((c) => c.path), ['a.txt']);
  assert.match(c1[0]!.diff, /-v0\n\+v1/);
  const c2 = snapshots.checkpointChanges(2);
  assert.deepEqual(c2.map((c) => [c.path, c.created]), [['a.txt', false], ['b.txt', true]]);
  assert.match(c2[0]!.diff, /-v1\n\+v2/);
});

test('картинки и звук прошлых ходов не уходят модели повторно', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'вот фото' }, { type: 'image', path: '/a.png' }] },
    { role: 'assistant', content: 'вижу' },
    { role: 'user', content: [{ type: 'text', text: 'а вот звук' }, { type: 'audio', path: '/b.wav' }] },
    { role: 'assistant', content: 'слышу' },
    { role: 'user', content: 'обычный текст' },
  ];
  const out = withoutOldMedia(msgs);
  assert.deepEqual((out[0] as any).content.map((p: any) => p.type), ['text', 'text']);
  assert.match((out[0] as any).content[1].text, /image attachment omitted/);
  assert.deepEqual((out[2] as any).content.map((p: any) => p.type), ['text', 'audio']);
  assert.equal(msgs[0]!.role === 'user' && (msgs[0] as any).content[1].type, 'image', 'исходная история не меняется');
});

test('заголовок сессии берётся из текста сообщения с вложениями', () => {
  const dir = tempProject();
  const store = new SessionStore(dir);
  store.append('s1', { role: 'user', content: [{ type: 'text', text: 'что  на\nфото?' }, { type: 'image', path: '/x.png' }] });
  assert.equal(store.list()[0]!.title, 'что на фото?');
  store.delete('s1');
  assert.equal(store.list().length, 0);
});
