import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_CATALOG, memoryFit, recommendedModelId } from '../src/model-catalog.ts';
import { AgentHost } from '../src/host.ts';

const byLabel = (l: string) => MODEL_CATALOG.find((e) => e.label === l)!;

test('каталог: уникальные id, закреплённые коммиты и хеши нужной длины, E2B первым', () => {
  assert.equal(MODEL_CATALOG[0]!.label, 'E2B');
  assert.equal(new Set(MODEL_CATALOG.map((e) => e.spec.id)).size, MODEL_CATALOG.length);
  for (const e of MODEL_CATALOG) {
    assert.match(e.spec.revision, /^[0-9a-f]{40}$/, e.spec.id);
    assert.equal(e.spec.license, 'Apache-2.0');
    assert.deepEqual(e.spec.files.map((f) => f.role), ['model', 'mmproj']);
    for (const f of e.spec.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.name);
      assert.ok(f.size > 1e8, f.name);
    }
  }
});

test('подходит ли по памяти: E2B с 8 ГБ, E4B с 16, 12B с 24; три четверти — впритык', () => {
  assert.equal(memoryFit(byLabel('E2B'), 8), 'ok');
  assert.equal(memoryFit(byLabel('E4B'), 8), 'no');
  assert.equal(memoryFit(byLabel('E4B'), 12), 'tight');
  assert.equal(memoryFit(byLabel('E4B'), 16), 'ok');
  assert.equal(memoryFit(byLabel('12B'), 16), 'no');
  assert.equal(memoryFit(byLabel('12B'), 18), 'tight');
  assert.equal(memoryFit(byLabel('12B'), 8), 'no');
  assert.equal(memoryFit(byLabel('12B'), 32), 'ok');
});

test('рекомендация: самая крупная модель, которая подходит; меньше 8 ГБ всё равно E2B', () => {
  assert.equal(recommendedModelId(4), byLabel('E2B').spec.id);
  assert.equal(recommendedModelId(8), byLabel('E2B').spec.id);
  assert.equal(recommendedModelId(16), byLabel('E4B').spec.id);
  assert.equal(recommendedModelId(24), byLabel('12B').spec.id);
  assert.equal(recommendedModelId(64), byLabel('12B').spec.id);
});

test('model.status отдаёт каталог, выбор модели меняет название и состав файлов, по умолчанию E2B', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gc-home-'));
  const host = new AgentHost({ home, backendFactory: () => null, ptyLoader: async () => { throw new Error('нет pty'); } });
  const first = await host.call('model.status', {});
  assert.equal(first.modelId, byLabel('E2B').spec.id);
  assert.equal(first.catalog.length, 3);
  assert.ok(first.catalog.every((o) => !o.installed));
  assert.ok(first.catalog.every((o) => o.modelBytes > 0 && o.mmprojBytes > 0));
  const e4b = await host.call('model.status', { modelId: byLabel('E4B').spec.id });
  assert.equal(e4b.modelId, byLabel('E4B').spec.id);
  assert.equal(e4b.title, byLabel('E4B').spec.title);
  assert.equal(e4b.files[0]!.name, 'gemma-4-E4B-it-Q4_K_M.gguf');
  // выбор запоминается до следующего запроса без id
  assert.equal((await host.call('model.status', {})).modelId, byLabel('E4B').spec.id);
  // неизвестный id не ломает: остаётся E2B
  assert.equal((await host.call('model.status', { modelId: 'нет-такой' })).modelId, byLabel('E2B').spec.id);
  await host.shutdown();
});
