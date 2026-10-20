import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager, normalizeSchema } from '../src/mcp/manager.ts';
import { Agent } from '../src/agent/loop.ts';
import { PermissionPolicy } from '../src/permissions/policy.ts';
import { createRegistry } from '../src/tools/registry.ts';
import { NoSandbox } from '../src/sandbox/index.ts';
import { validateArgs } from '../src/tools/validate.ts';
import { ScriptedBackend, tempProject } from './helpers.ts';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-server.mjs');
const cfg = { fixture: { command: process.execPath, args: [SERVER] } };

test('MCP: подключение по stdio, имена с префиксом, лимит инструментов', async () => {
  const mgr = new McpManager({ cwd: tempProject(), maxToolsPerServer: 4 });
  try {
    const info = await mgr.connect({ ...cfg, broken: { command: '/nonexistent/binary' }, off: { command: 'x', disabled: true } });
    const by = Object.fromEntries(info.map((i) => [i.name, i]));
    assert.equal(by.fixture!.status, 'connected');
    assert.deepEqual(by.fixture!.tools, ['mcp__fixture__echo', 'mcp__fixture__fail', 'mcp__fixture__page', 'mcp__fixture__t4']);
    assert.equal(by.fixture!.skipped, 1);
    assert.equal(by.broken!.status, 'failed');
    assert.equal(by.off!.status, 'disabled');
    const echo = mgr.tools().find((t) => t.name === 'mcp__fixture__echo')!;
    assert.equal(echo.risk, 'external');
    assert.match(echo.description, /^\[fixture\] Echo the text back/);
    assert.deepEqual(echo.parameters.required, ['text']);
    const ctx = { cwd: '/x', sessionId: 's', todos: [] };
    const ok = await echo.run({ text: 'hi', times: 2 }, ctx);
    assert.equal(ok.content, 'hi hi');
    assert.equal(ok.untrusted, true);
    const fail = await mgr.tools().find((t) => t.name === 'mcp__fixture__fail')!.run({}, ctx);
    assert.ok(fail.isError && fail.content === 'boom');
  } finally {
    await mgr.close();
  }
});

test('MCP: результат помечает сессию недоверенной, правки после него требуют подтверждения', async () => {
  const dir = tempProject({ 'a.txt': 'one' });
  const mgr = new McpManager({ cwd: dir });
  try {
    await mgr.connect(cfg);
    const registry = createRegistry('edit');
    for (const t of mgr.tools()) registry.register(t);
    const asked: string[] = [];
    const agent = new Agent({
      backend: new ScriptedBackend([
        { calls: [{ name: 'mcp__fixture__page', args: {} }] },
        { calls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'one', new_string: 'pwned' } }] },
        { text: 'ok' },
      ]),
      cwd: dir,
      registry,
      policy: new PermissionPolicy({ mode: 'auto-edit', cwd: dir, sandboxEnforced: true }),
      sandbox: new NoSandbox(),
      approve: async (r) => (asked.push(`${r.tool}: ${r.reason}`), r.tool === 'edit_file' ? 'deny' : 'allow'),
    });
    for await (const _ of agent.send('open the page')) void _;
    assert.deepEqual(asked, ['mcp__fixture__page: External tool (MCP)', 'edit_file: Untrusted content was read in this session.']);
    assert.equal((await import('node:fs')).readFileSync(join(dir, 'a.txt'), 'utf8'), 'one');
  } finally {
    await mgr.close();
  }
});

test('MCP: схема нормализуется, сложные свойства пропускаются без отказа', () => {
  const s = normalizeSchema({ type: 'object', properties: { a: { type: ['null', 'string'], description: 'x' }, b: { anyOf: [{ type: 'string' }, { type: 'number' }] }, c: { enum: ['x', 'y'], type: 'string' } }, required: ['a', 'zzz'] });
  assert.equal(s.properties.a!.type, 'string');
  assert.equal(s.properties.b!.type, 'any');
  assert.deepEqual(s.required, ['a']);
  const v = validateArgs(s, { a: 'q', b: { anything: 1 }, extra: 1 }, 'mcp__x__y');
  assert.ok(v.ok && v.args.extra === 1);
  assert.ok(!validateArgs(s, { c: 'z' }, 'mcp__x__y').ok);
});
