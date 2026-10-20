#!/usr/bin/env node
// Точка входа: Node 22.6+ запускает TypeScript с флагом, Node 23.6+ и 26 без него.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
const needsFlag = major < 23 || (major === 23 && minor < 6);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error('GemmaCode CLI требует Node.js 22.6 или новее.');
  process.exit(1);
}
const args = [...(needsFlag ? ['--experimental-strip-types'] : []), '--disable-warning=ExperimentalWarning', main, ...process.argv.slice(2)];
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
