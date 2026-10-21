// Собирает сервис агента (ядро + host) в один файл для utility-процесса Electron.
// Electron 45 несёт Node 24, но запускать TypeScript из исходников в упакованном приложении нельзя, поэтому бандл.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  entryPoints: [`${root}../../packages/host/src/transports/electron-entry.ts`],
  outfile: `${root}dist/host/host.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // node-pty подгружается лениво по имени пакета и лежит рядом с приложением (нативные модули не бандлятся)
  external: ['@lydell/node-pty', 'electron'],
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
});
