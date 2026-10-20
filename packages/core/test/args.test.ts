import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServerArgs, type ServerConfig } from '../src/inference/args.ts';

const base: ServerConfig = {
  binary: 'llama-server',
  port: 8801,
  model: { hf: 'ggml-org/gemma-4-E2B-it-GGUF:Q8_0' },
  multimodal: false,
  contextSize: 16384,
  kvCacheType: 'q8_0',
  reasoning: 'off',
  speculative: 'none',
};

test('текстовый режим отключает проектор и мышление', () => {
  const a = buildServerArgs(base);
  assert.deepEqual(a.slice(0, 3), ['-hf', 'ggml-org/gemma-4-E2B-it-GGUF:Q8_0', '--no-mmproj']);
  assert.ok(a.includes('--reasoning') && a[a.indexOf('--reasoning') + 1] === 'off');
  assert.ok(!a.includes('--spec-type'));
});

test('спекулятивный декодинг и локальный файл с проектором', () => {
  const a = buildServerArgs({
    ...base,
    model: { file: '/m/e2b.gguf', mmproj: '/m/mmproj.gguf' },
    multimodal: true,
    speculative: 'ngram-mod',
  });
  assert.deepEqual(a.slice(0, 4), ['-m', '/m/e2b.gguf', '--mmproj', '/m/mmproj.gguf']);
  assert.equal(a[a.indexOf('--spec-type') + 1], 'ngram-mod');
  assert.ok(!a.includes('--no-mmproj'));
});
