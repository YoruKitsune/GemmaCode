import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '../src/agent/loop.ts';
import { detectVerifyCommand, runTask, type RunnerEvent, type RunOptions } from '../src/agent/runner.ts';
import { parseReview } from '../src/agent/review.ts';
import { unifiedDiff } from '../src/snapshot/diff.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { PermissionPolicy } from '../src/permissions/policy.ts';
import { createRegistry } from '../src/tools/registry.ts';
import { NoSandbox } from '../src/sandbox/index.ts';
import { ScriptedBackend, tempProject, type Scripted } from './helpers.ts';

function mk(dir: string, script: (Scripted | ((r: any) => Scripted))[]) {
  const backend = new ScriptedBackend(script);
  const snapshots = new SnapshotStore(dir, 'r');
  const agent = new Agent({
    backend,
    cwd: dir,
    registry: createRegistry('edit'),
    policy: new PermissionPolicy({ mode: 'full', cwd: dir, sandboxEnforced: true }),
    sandbox: new NoSandbox(),
    snapshots,
  });
  return { agent, backend, snapshots };
}

async function collect(agent: Agent, task: string, opts: RunOptions): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of runTask(agent, task, opts)) out.push(e);
  return out;
}

const last = (ev: RunnerEvent[]) => ev[ev.length - 1] as Extract<RunnerEvent, { type: 'run_done' }>;
const verifies = (ev: RunnerEvent[]) => ev.filter((e) => e.type === 'verify') as Extract<RunnerEvent, { type: 'verify' }>[];

const PROJECT = {
  'math.js': 'export const add = (a, b) => a - b;\n',
  'check.mjs': "import { add } from './math.js';\nif (add(2, 3) !== 5) { console.error('add(2,3) expected 5, got ' + add(2, 3)); process.exit(1); }\n",
};
const fixAdd = { calls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] };

test('unifiedDiff: добавление, удаление, контекст', () => {
  const d = unifiedDiff('f.js', 'a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nX\ne\nf\ng\nh\n', 1);
  assert.equal(d, '--- a/f.js\n+++ b/f.js\n@@ -3,3 +3,3 @@\n c\n-d\n+X\n e');
  assert.equal(unifiedDiff('n.js', null, 'x\ny\n'), '--- /dev/null\n+++ b/n.js\n@@ -1,0 +1,2 @@\n+x\n+y');
  assert.equal(unifiedDiff('s.js', 'same\n', 'same\n'), '');
});

test('diffSince: оригинал берётся из снимка, новый файл помечен', async () => {
  const dir = tempProject({ 'a.txt': 'one\ntwo\n' });
  const { agent, snapshots } = mk(dir, [
    { calls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'two', new_string: '2' } }, { name: 'write_file', args: { path: 'n.txt', content: 'new\n' } }] },
    { text: 'ok' },
  ]);
  for await (const _ of agent.send('x')) void _;
  const d = snapshots.diffSince(1);
  assert.match(d, /--- a\/a\.txt[\s\S]*-two\n\+2/);
  assert.match(d, /--- \/dev\/null\n\+\+\+ b\/n\.txt/);
});

test('loop: проверка падает, агент получает вывод и исправляет', async () => {
  const dir = tempProject(PROJECT);
  const { agent, backend } = mk(dir, [{ text: 'Я посмотрел, всё выглядит верно.' }, fixAdd, { text: 'Исправил.' }]);
  const ev = await collect(agent, 'add() должна складывать', { verify: 'node check.mjs' });
  assert.deepEqual(verifies(ev).map((v) => v.passed), [false, true]);
  assert.equal(last(ev).outcome, 'verified');
  assert.equal(last(ev).iterations, 2);
  assert.equal(readFileSync(join(dir, 'math.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  const feedback = backend.requests[1]!.messages.filter((m) => m.role === 'user').pop()!.content as string;
  assert.match(feedback, /check `node check\.mjs` failed \(exit code 1\)/);
  assert.match(feedback, /expected 5, got -1/);
});

test('loop: лимит попыток', async () => {
  const dir = tempProject(PROJECT);
  const noop = (n: number) => ({ calls: [{ name: 'write_file', args: { path: `junk${n}.txt`, content: String(n) } }] });
  const { agent } = mk(dir, [noop(1), { text: 'a' }, noop(2), { text: 'b' }]);
  const ev = await collect(agent, 'fix', { verify: 'node check.mjs', maxIterations: 2 });
  assert.equal(last(ev).outcome, 'max_iterations');
  assert.equal(verifies(ev).length, 2);
});

test('loop: без прогресса (тот же вывод, ничего не менялось) останавливается', async () => {
  const dir = tempProject(PROJECT);
  const { agent } = mk(dir, [{ text: 'нечего менять' }, { text: 'всё ещё нечего' }, { text: 'и опять' }]);
  const ev = await collect(agent, 'fix', { verify: 'node check.mjs', maxIterations: 5 });
  assert.equal(last(ev).outcome, 'no_progress');
  assert.equal(last(ev).iterations, 2);
});

test('loop: зелёная проверка с первой попытки — одна итерация', async () => {
  const dir = tempProject({ 'ok.mjs': 'process.exit(0)\n' });
  const { agent } = mk(dir, [{ text: 'готово' }]);
  const ev = await collect(agent, 'nothing', { verify: 'node ok.mjs' });
  assert.equal(last(ev).outcome, 'verified');
  assert.equal(last(ev).iterations, 1);
});

test('без проверки и ревью: одна итерация, outcome completed', async () => {
  const dir = tempProject(PROJECT);
  const { agent } = mk(dir, [{ text: 'просто ответ' }]);
  const ev = await collect(agent, 'вопрос', {});
  assert.equal(last(ev).outcome, 'completed');
  assert.ok(!ev.some((e) => e.type === 'verify' || e.type === 'review'));
});

const issues = (evidence: string, severity = 'high') => ({
  text: JSON.stringify({ verdict: 'issues', issues: [{ file: 'math.js', severity, problem: 'Operator is wrong', evidence }] }),
});

test('само-ревью: замечание с цитатой возвращается агенту и правится', async () => {
  const dir = tempProject({ 'math.js': 'export const add = (a, b) => a - b;\n', 'check.mjs': 'process.exit(0)\n' });
  const { agent, backend } = mk(dir, [
    { calls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a * b' } }] },
    { text: 'сделал' },
    issues('export const add = (a, b) => a * b;'),
    { calls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a * b', new_string: 'a + b' } }] },
    { text: 'исправил по ревью' },
    { text: JSON.stringify({ verdict: 'ok', issues: [] }) },
  ]);
  const ev = await collect(agent, 'make add() add numbers', { verify: 'node check.mjs', review: true, maxReviewRounds: 2 });
  const reviews = ev.filter((e) => e.type === 'review') as Extract<RunnerEvent, { type: 'review' }>[];
  assert.deepEqual(reviews.map((r) => r.verdict), ['issues', 'ok']);
  assert.equal(last(ev).outcome, 'verified');
  assert.equal(readFileSync(join(dir, 'math.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  // ревью идёт в свежем контексте: только system и user, без истории агента, схема задана
  const rq = backend.requests[2]!;
  assert.equal(rq.messages.length, 2);
  assert.ok(rq.jsonSchema);
  assert.match(rq.messages[1]!.content as string, /Task:\nmake add\(\) add numbers/);
  assert.match(rq.messages[1]!.content as string, /\+export const add = \(a, b\) => a \* b;/);
  const feedback = backend.requests[3]!.messages.filter((m) => m.role === 'user').pop()!.content as string;
  assert.match(feedback, /review of your changes found problems/);
});

test('само-ревью: выдуманные и малозначимые замечания отбрасываются', async () => {
  const dir = tempProject({ 'math.js': 'export const add = (a, b) => a - b;\n' });
  const { agent } = mk(dir, [
    { calls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] },
    { text: 'ok' },
    { text: JSON.stringify({ verdict: 'issues', issues: [
      { file: 'math.js', severity: 'high', problem: 'invented', evidence: 'this line is not in the diff' },
      { file: 'math.js', severity: 'low', problem: 'style', evidence: 'export const add = (a, b) => a + b;' },
    ] }) },
  ]);
  const ev = await collect(agent, 'fix add', { review: true });
  const r = ev.find((e) => e.type === 'review') as Extract<RunnerEvent, { type: 'review' }>;
  assert.equal(r.verdict, 'ok');
  assert.equal(r.dropped, 2);
  assert.equal(last(ev).outcome, 'completed');
  assert.equal(last(ev).reviewRounds, 1);
});

test('само-ревью: без изменений пропускается без вызова модели', async () => {
  const dir = tempProject(PROJECT);
  const { agent, backend } = mk(dir, [{ text: 'ничего менять не нужно' }]);
  const ev = await collect(agent, 'explain', { review: true });
  assert.equal((ev.find((e) => e.type === 'review') as any).verdict, 'skipped');
  assert.equal(backend.requests.length, 1);
});

test('parseReview: битый JSON не ломает ход', () => {
  assert.deepEqual(parseReview('not json', ''), { verdict: 'ok', issues: [], dropped: 0 });
});

test('detectVerifyCommand', () => {
  assert.equal(detectVerifyCommand(tempProject({ 'package.json': '{"scripts":{"test":"node --test"}}' })), 'npm test');
  assert.equal(detectVerifyCommand(tempProject({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
  assert.equal(detectVerifyCommand(tempProject({ 'test/a.test.js': '' })), 'node --test');
  assert.equal(detectVerifyCommand(tempProject({ 'Cargo.toml': '' })), 'cargo test');
  assert.equal(detectVerifyCommand(tempProject({})), null);
});
