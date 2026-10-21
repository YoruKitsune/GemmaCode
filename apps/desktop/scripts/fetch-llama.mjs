// Кладёт закреплённую сборку llama.cpp в apps/desktop/resources/llama/<платформа>-<архитектура>/ для установщика.
// Версия и SHA-256 прибиты: флаги в packages/core/src/inference/args.ts проверены именно по этой сборке (b11669, commit 620d2225c).
//
//   node scripts/fetch-llama.mjs [--platform darwin|linux|win32] [--arch arm64|x64] [--variant cpu|vulkan]
//                                [--archive путь.tar.gz|zip]   готовый архив вместо загрузки (хеш всё равно проверяется)
//                                [--cache каталог]             куда класть скачанный архив (по умолчанию .cache/llama)
//
// Проверка хеша идёт до распаковки; при несовпадении ничего не распаковывается и скрипт падает.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TAG = 'b11669';
const BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}`;

/** Ресурсы релиза b11669 (sha256 из API релиза). cpu — без ускорителей на Linux и Windows (на macOS Metal входит в сборку). */
const ASSETS = {
  'darwin-arm64': { cpu: ['llama-b11669-bin-macos-arm64.tar.gz', 'dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd'] },
  'darwin-x64': { cpu: ['llama-b11669-bin-macos-x64.tar.gz', 'cab28238d78158109b48deb27b05d50e0dcef56275d2e76da9ca8281526c7532'] },
  'linux-x64': {
    cpu: ['llama-b11669-bin-ubuntu-x64.tar.gz', 'cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac'],
    vulkan: ['llama-b11669-bin-ubuntu-vulkan-x64.tar.gz', 'e8709e5ba6c1b093dea7f3de57f4aba842f9a188fba6b465782d65d6fcfa4d9f'],
  },
  'linux-arm64': { cpu: ['llama-b11669-bin-ubuntu-arm64.tar.gz', '9ac6fda2058d35677608a06f751a50122ddfa4ce0ddb7f084466b8e79b6d4a99'] },
  'win32-x64': {
    cpu: ['llama-b11669-bin-win-cpu-x64.zip', '37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b'],
    vulkan: ['llama-b11669-bin-win-vulkan-x64.zip', '2c07574e7bde71321cb785282b20cc821e951132149eeceeea32ddebdbf0598e'],
  },
  'win32-arm64': { cpu: ['llama-b11669-bin-win-cpu-arm64.zip', '9cff39ffed17edcd03a7d876073f74d7b48cd43a1e5eafdd59ee094185ad871b'] },
};

const here = fileURLToPath(new URL('..', import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const platform = arg('platform') ?? process.platform;
const arch = arg('arch') ?? process.arch;
const variant = arg('variant') ?? 'cpu';
const key = `${platform}-${arch}`;
const asset = ASSETS[key]?.[variant];
if (!asset) {
  console.error(`Нет закреплённой сборки llama.cpp для ${key}/${variant}. Есть: ${Object.entries(ASSETS).map(([k, v]) => `${k} (${Object.keys(v).join(', ')})`).join('; ')}`);
  process.exit(2);
}
const [name, sha256] = asset;
const outDir = join(here, 'resources', 'llama', key);
const stamp = join(outDir, '.pinned');
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === `${TAG} ${variant} ${sha256}`) {
  console.log(`llama.cpp ${TAG} (${key}, ${variant}) уже на месте: ${outDir}`);
  process.exit(0);
}

const hashOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
let archive = arg('archive');
if (!archive) {
  const cache = arg('cache') ?? join(here, '.cache', 'llama');
  mkdirSync(cache, { recursive: true });
  archive = join(cache, name);
  if (!existsSync(archive) || hashOf(archive) !== sha256) {
    console.log(`Скачиваю ${BASE}/${name}`);
    const res = await fetch(`${BASE}/${name}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${name}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }
}
const got = hashOf(archive);
if (got !== sha256) {
  console.error(`SHA-256 ${basename(archive)} не совпал: ожидался ${sha256}, получен ${got}. Ничего не распаковано.`);
  process.exit(1);
}
console.log(`SHA-256 совпал (${sha256.slice(0, 16)}…)`);

const tmp = mkdtempSync(join(tmpdir(), 'llama-pin-'));
try {
  // bsdtar (macOS, Linux, Windows 10+) читает и tar.gz, и zip
  execFileSync('tar', ['-xf', archive, '-C', tmp], { stdio: 'inherit' });
  const top = readdirSync(tmp);
  const root = top.length === 1 && statSync(join(tmp, top[0])).isDirectory() ? join(tmp, top[0]) : tmp;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const exe = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  // llama-server, его библиотеки (в том числе символические ссылки) и лицензия; остальные утилиты в установщик не нужны
  // (библиотеки других утилит вида libllama-cli-impl, -bench-impl и т. п. сюда не входят)
  const otherTool = (f) => /^(lib)?llama-.*-impl/.test(f) && !/^(lib)?llama-server-impl/.test(f);
  const keep = (f) => f === exe || (/\.(dylib|so(\.\d+)*|dll)$/.test(f) && !otherTool(f)) || /^LICENSE/i.test(f);
  for (const f of readdirSync(root).filter(keep)) cpSync(join(root, f), join(outDir, f), { recursive: true, verbatimSymlinks: true });
  if (!existsSync(join(outDir, exe))) throw new Error(`В архиве нет ${exe}`);
  writeFileSync(stamp, `${TAG} ${variant} ${sha256}\n`);
  console.log(`Готово: ${outDir} (${readdirSync(outDir).length} файлов)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
