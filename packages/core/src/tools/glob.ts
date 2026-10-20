import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.gemmacode', '.DS_Store', '__pycache__', '.venv']);

/** Glob -> RegExp: `**`, `*`, `?`, `{a,b}`, `[abc]`. Совпадение по пути с «/» как разделителем. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += glob.slice(i, end + 1).replace(/\\/g, '\\\\');
        i = end;
      }
    } else if ('.+^$()|\\/'.includes(c)) re += `\\${c}`;
    else re += c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** Минимальная поддержка .gitignore: имена и пути каталогов/файлов, `*.ext`, комментарии; отрицания игнорируются. */
export function loadGitignore(root: string): ((rel: string, isDir: boolean) => boolean) {
  const rules: { re: RegExp; dirOnly: boolean }[] = [];
  try {
    for (const raw of readFileSync(join(root, '.gitignore'), 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const dirOnly = line.endsWith('/');
      let pat = dirOnly ? line.slice(0, -1) : line;
      const anchored = pat.startsWith('/') || pat.includes('/');
      pat = pat.replace(/^\//, '');
      const body = globToRegExp(pat).source.slice(1, -1);
      rules.push({ re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`), dirOnly });
    }
  } catch {
    // .gitignore нет
  }
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(rel));
}

export interface WalkOptions {
  /** Обходить и каталоги, которые обычно скрыты (node_modules и т. п.). */
  includeIgnored?: boolean;
  maxFiles?: number;
}

/** Обход каталога: относительные пути с «/», отсортированы, скрытые каталоги и .gitignore учтены. */
export function walkFiles(root: string, start: string, opts: WalkOptions = {}): string[] {
  const max = opts.maxFiles ?? 20000;
  const ignored = opts.includeIgnored ? () => false : loadGitignore(root);
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= max) return;
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      const isDir = e.isDirectory();
      if (!opts.includeIgnored && (ALWAYS_IGNORED.has(e.name) || ignored(rel, isDir))) continue;
      if (isDir) visit(abs);
      else if (e.isFile()) out.push(rel);
    }
  };
  try {
    if (statSync(start).isFile()) return [relative(root, start).split(sep).join('/')];
  } catch {
    return [];
  }
  visit(start);
  return out;
}

export { ALWAYS_IGNORED };
