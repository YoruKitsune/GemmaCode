import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Каталог платформы в сборке: `<resources>/llama/<платформа>-<архитектура>/`. */
export function llamaPlatformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function llamaExecutableName(platform: string = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/**
 * Какой llama-server запускать. Порядок: путь из настроек (явный выбор пользователя), закреплённая сборка из установщика
 * (каталог в `GEMMACODE_LLAMA_DIR`, его выставляет оболочка), иначе `llama-server` из PATH. Флаги в args.ts проверены по
 * закреплённой сборке (см. docs/M4.md); чужая версия из PATH может их не знать, поэтому она последняя в списке.
 */
export function resolveLlamaBinary(configured?: string, env: NodeJS.ProcessEnv = process.env): { binary: string; source: 'settings' | 'bundled' | 'path' } {
  if (configured) return { binary: configured, source: 'settings' };
  const dir = env.GEMMACODE_LLAMA_DIR;
  if (dir) {
    const bundled = join(dir, llamaPlatformKey(), llamaExecutableName());
    if (existsSync(bundled)) return { binary: bundled, source: 'bundled' };
  }
  return { binary: 'llama-server', source: 'path' };
}
