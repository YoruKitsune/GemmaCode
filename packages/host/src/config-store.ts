import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FoundModel, ServerSettings, Settings } from '@gemmacode/protocol';

export function userConfigPath(home: string): string {
  return join(home, '.gemmacode', 'config.json');
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** Записывает настройки окна в пользовательский конфиг. Чужие ключи (mcpServers, permissions…) не трогаем. */
export function patchUserConfig(home: string, patch: Partial<Settings>): void {
  const file = userConfigPath(home);
  const cur = readJson(file);
  if (patch.mode) cur.mode = patch.mode;
  if (patch.toolset) cur.toolset = patch.toolset;
  if (patch.contextSize) cur.contextSize = patch.contextSize;
  if (patch.server) {
    const server: Record<string, unknown> = { ...((cur.server as Record<string, unknown> | undefined) ?? {}) };
    for (const [k, v] of Object.entries(patch.server) as [keyof ServerSettings, unknown][]) {
      if (v === undefined || v === '') delete server[k];
      else server[k] = v;
    }
    cur.server = server;
  }
  writeJson(userConfigPath(home), cur);
}

export interface AppMemory {
  recentProjects: string[];
  lastProject?: string;
  lastSession?: string;
}

const appFile = (home: string) => join(home, '.gemmacode', 'app.json');

export function readAppMemory(home: string): AppMemory {
  const raw = readJson(appFile(home));
  return {
    recentProjects: Array.isArray(raw.recentProjects) ? raw.recentProjects.filter((p): p is string => typeof p === 'string') : [],
    ...(typeof raw.lastProject === 'string' ? { lastProject: raw.lastProject } : {}),
    ...(typeof raw.lastSession === 'string' ? { lastSession: raw.lastSession } : {}),
  };
}

export function writeAppMemory(home: string, m: AppMemory): void {
  writeJson(appFile(home), m);
}

const MODEL_ROOTS = (home: string): { dir: string; depth: number }[] => [
  { dir: join(home, '.gemmacode', 'models'), depth: 2 },
  { dir: join(home, 'models'), depth: 3 },
  { dir: join(home, 'Models'), depth: 3 },
  { dir: join(home, 'Downloads'), depth: 2 },
  { dir: join(home, 'Library', 'Caches', 'llama.cpp'), depth: 2 },
  { dir: join(home, '.cache', 'llama.cpp'), depth: 2 },
  { dir: join(home, '.cache', 'huggingface', 'hub'), depth: 5 },
  { dir: join(home, '.lmstudio', 'models'), depth: 4 },
  { dir: join(home, 'Projects'), depth: 3 },
];

/** Ищет GGUF-модели в обычных местах и сопоставляет им проекционный файл (mmproj) из того же каталога. Только Gemma. */
export function scanModels(home: string, limit = 40): FoundModel[] {
  const found = new Map<string, FoundModel>();
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (visited > 6000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const ggufs = entries.filter((e) => (e.isFile() || e.isSymbolicLink()) && /\.gguf$/i.test(e.name));
    const proj = ggufs.find((e) => /mmproj/i.test(e.name));
    for (const e of ggufs) {
      if (/mmproj/i.test(e.name) || !/gemma/i.test(e.name)) continue;
      const file = join(dir, e.name);
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size < 200_000_000) continue; // не модель, а огрызок или тестовый файл
      const quant = /(?:^|[-_.])((?:UD-)?I?Q\d(?:_[A-Z0-9]+)*|F16|BF16)(?=[-_.]|$)/i.exec(basename(e.name, '.gguf'))?.[1];
      found.set(file, { file, sizeMB: Math.round(size / 1e6), ...(proj ? { mmproj: join(dir, proj.name) } : {}), ...(quant ? { quant: quant.toUpperCase() } : {}) });
    }
    if (depth <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') && !['.cache', '.gemmacode', '.lmstudio'].includes(e.name) || e.name === 'node_modules') continue;
      visited++;
      walk(join(dir, e.name), depth - 1);
    }
  };
  for (const r of MODEL_ROOTS(home)) if (existsSync(r.dir)) walk(r.dir, r.depth);
  return [...found.values()].sort((a, b) => a.sizeMB - b.sizeMB).slice(0, limit);
}
