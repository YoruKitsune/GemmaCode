import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServerArgs, DEFAULT_SPECULATIVE, NGRAM_M, NGRAM_N, type ServerConfig } from '../src/inference/args.ts';
import { effectiveSpeculative } from '../src/inference/factory.ts';

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

test('ngram-simple получает размеры n-грамма своими флагами', () => {
  const a = buildServerArgs({ ...base, speculative: 'ngram-simple' });
  assert.equal(a[a.indexOf('--spec-type') + 1], 'ngram-simple');
  assert.equal(a[a.indexOf('--spec-ngram-simple-size-n') + 1], String(NGRAM_N));
  assert.equal(a[a.indexOf('--spec-ngram-simple-size-m') + 1], String(NGRAM_M));
});

test('ngram-map-k: свои флаги и свои размеры', () => {
  const a = buildServerArgs({ ...base, speculative: 'ngram-map-k', ngram: { n: 8, m: 16 } });
  assert.equal(a[a.indexOf('--spec-ngram-map-k-size-n') + 1], '8');
  assert.equal(a[a.indexOf('--spec-ngram-map-k-size-m') + 1], '16');
  assert.ok(!a.includes('--spec-ngram-simple-size-n'));
});

test('none и ngram-mod не получают флагов размера', () => {
  assert.ok(!buildServerArgs({ ...base, speculative: 'none' }).some((x) => x.startsWith('--spec')));
  const mod = buildServerArgs({ ...base, speculative: 'ngram-mod' });
  assert.ok(!mod.some((x) => x.includes('size-n')));
});

test('режим по умолчанию: ngram-simple, пустое и неизвестное значение тоже дают его', () => {
  assert.equal(DEFAULT_SPECULATIVE, 'ngram-simple');
  assert.equal(effectiveSpeculative({}), 'ngram-simple');
  assert.equal(effectiveSpeculative({ speculative: 'none' }), 'none');
  assert.equal(effectiveSpeculative({ speculative: 'ngram-map-k' }), 'ngram-map-k');
  assert.equal(effectiveSpeculative({ speculative: 'bogus' as never }), 'ngram-simple');
});
