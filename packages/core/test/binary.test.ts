import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llamaExecutableName, llamaPlatformKey, resolveLlamaBinary } from '../src/inference/binary.ts';
import { tempProject } from './helpers.ts';

test('llama-server: настройка главнее встроенной сборки, встроенная главнее PATH', () => {
  const dir = tempProject();
  const key = llamaPlatformKey();
  mkdirSync(join(dir, key), { recursive: true });
  const exe = join(dir, key, llamaExecutableName());
  writeFileSync(exe, '#!/bin/sh\n');
  chmodSync(exe, 0o755);
  assert.deepEqual(resolveLlamaBinary('/opt/my/llama-server', { GEMMACODE_LLAMA_DIR: dir }), { binary: '/opt/my/llama-server', source: 'settings' });
  assert.deepEqual(resolveLlamaBinary(undefined, { GEMMACODE_LLAMA_DIR: dir }), { binary: exe, source: 'bundled' });
  assert.deepEqual(resolveLlamaBinary(undefined, {}), { binary: 'llama-server', source: 'path' });
  // каталог указан, но сборки для этой платформы в нём нет: падаем обратно на PATH
  assert.deepEqual(resolveLlamaBinary(undefined, { GEMMACODE_LLAMA_DIR: join(dir, 'нет') }), { binary: 'llama-server', source: 'path' });
});

test('имена каталогов и файлов по платформам', () => {
  assert.equal(llamaPlatformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(llamaExecutableName('win32'), 'llama-server.exe');
  assert.equal(llamaExecutableName('linux'), 'llama-server');
});
