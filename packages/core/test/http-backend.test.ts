import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttachedBackend } from '../src/inference/llama-server.ts';
import { Agent } from '../src/agent/loop.ts';
import { PermissionPolicy } from '../src/permissions/policy.ts';
import { createRegistry } from '../src/tools/registry.ts';
import { NoSandbox } from '../src/sandbox/index.ts';
import { loadConfig } from '../src/config/load.ts';
import { startFakeServer } from './fixtures/fake-openai-server.ts';
import { tempProject } from './helpers.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

test('AttachedBackend: потоковые дельты, вызов инструмента из кусков, тайминги, полный ход агента', async () => {
  const dir = tempProject({ 'a.txt': 'old value' });
  const srv = await startFakeServer([
    { call: { name: 'edit_file', args: { path: 'a.txt', old_string: 'old', new_string: 'new' } } },
    { text: 'Готово, значение обновлено.' },
  ]);
  try {
    const backend = new AttachedBackend(srv.url);
    await backend.start();
    assert.equal(backend.status, 'ready');
    const agent = new Agent({
      backend, cwd: dir, registry: createRegistry('edit'), sandbox: new NoSandbox(),
      policy: new PermissionPolicy({ mode: 'auto-edit', cwd: dir, sandboxEnforced: true }),
    });
    const events: string[] = [];
    for await (const e of agent.send('замени old на new')) events.push(e.type);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'new value');
    assert.ok(events.includes('timings'));
    assert.equal(events.at(-1), 'done');
    const first = srv.requests[0];
    assert.equal(first.stream, true);
    assert.equal(first.cache_prompt, true);
    assert.equal(first.tools.length, 8);
    assert.equal(first.tools[0].type, 'function');
    assert.equal(first.messages[0].role, 'system');
    // второй запрос содержит вызов и результат в формате OpenAI
    const second = srv.requests[1].messages;
    assert.equal(second[2].role, 'assistant');
    assert.equal(second[2].tool_calls[0].function.name, 'edit_file');
    assert.equal(JSON.parse(second[2].tool_calls[0].function.arguments).new_string, 'new');
    assert.equal(second[3].role, 'tool');
    assert.equal(second[3].tool_call_id, second[2].tool_calls[0].id);
    assert.equal(agent.stats.genTokensPerSecond, 21.5);
    assert.equal(agent.stats.promptTokens, 240);
  } finally {
    await srv.close();
  }
});

test('AttachedBackend: недоступный сервер даёт понятную ошибку', async () => {
  await assert.rejects(() => new AttachedBackend('http://127.0.0.1:1').start(), /не отвечает/);
});

test('конфиг: пользовательский + проектный, проверка значений, правила и MCP', () => {
  const home = tempProject();
  const proj = tempProject();
  mkdirSync(join(home, '.gemmacode'), { recursive: true });
  mkdirSync(join(proj, '.gemmacode'), { recursive: true });
  writeFileSync(join(home, '.gemmacode/config.json'), JSON.stringify({ mode: 'auto-edit', contextSize: 8192, permissions: { allow: ['shell(npm test*)'] }, server: { binary: 'llama-server', port: 9000 } }));
  writeFileSync(join(proj, '.gemmacode/config.json'), JSON.stringify({ mode: 'bogus', toolCallMode: 'schema', permissions: { allow: ['edit_file(src/**)'], deny: ['shell(rm*)'] }, mcpServers: { a: { command: 'x' }, b: {} }, server: { modelFile: '/m.gguf' } }));
  const { config, warnings } = loadConfig(proj, home);
  assert.equal(config.mode, 'auto-edit');
  assert.equal(config.toolCallMode, 'schema');
  assert.equal(config.contextSize, 8192);
  assert.deepEqual(config.permissions, { allow: ['shell(npm test*)', 'edit_file(src/**)'], deny: ['shell(rm*)'] });
  assert.deepEqual(Object.keys(config.mcpServers), ['a']);
  assert.deepEqual(config.server, { binary: 'llama-server', port: 9000, modelFile: '/m.gguf' });
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /"mode" must be one of/);
});
