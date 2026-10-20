import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Абсолютный путь из аргумента модели; `~` раскрывается в домашний каталог. */
export function resolveUserPath(cwd: string, p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** realpath существующей части пути: защита от выхода из проекта через симлинк. */
export function realish(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

export function isInside(root: string, abs: string): boolean {
  const rel = relative(realish(root), realish(abs));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs;
}

const SECRET_NAME = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];
const SECRET_NAME_ALLOW = [/^\.env\.(example|sample|template|dist)$/i];

const SECRET_HOME_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.azure',
  'Library/Keychains',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Arc',
  'Library/Safari',
  'Library/Cookies',
  '.config/google-chrome',
  '.config/chromium',
  '.mozilla',
  'AppData/Local/Google/Chrome',
  'AppData/Roaming/Mozilla',
];

/** Запретный список из плана: секреты, ключи, хранилища браузеров. Возвращает причину или null. */
export function forbiddenReason(abs: string, home = homedir()): string | null {
  const real = realish(abs);
  const name = basename(real);
  if (!SECRET_NAME_ALLOW.some((r) => r.test(name)) && SECRET_NAME.some((r) => r.test(name))) {
    return `${name} looks like a secrets file`;
  }
  for (const d of SECRET_HOME_DIRS) {
    const dir = join(home, d);
    const rel = relative(dir, real);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return `~/${d} is protected`;
  }
  return null;
}

export const SECRET_HOME_PATHS = SECRET_HOME_DIRS;
