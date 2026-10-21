import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { ALWAYS_IGNORED, isInside, loadGitignore, walkFiles } from '@gemmacode/core';
import type { DirEntry, FileContent, GitStatus, SearchHit } from '@gemmacode/protocol';

const HIDDEN = new Set(['.git', '.gemmacode', '.DS_Store']);
const MAX_TEXT_BYTES = 1_000_000;
const MAX_MEDIA_BYTES = 25_000_000;

const IMAGE = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['svg', 'image/svg+xml'], ['bmp', 'image/bmp'], ['ico', 'image/x-icon']]);
const AUDIO = new Map([['wav', 'audio/wav'], ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['ogg', 'audio/ogg'], ['flac', 'audio/flac'], ['aac', 'audio/aac']]);
const VIDEO = new Map([['mp4', 'video/mp4'], ['mov', 'video/quicktime'], ['webm', 'video/webm'], ['mkv', 'video/x-matroska']]);

export const extOf = (p: string): string => extname(p).slice(1).toLowerCase();
export const toPosix = (p: string): string => p.split(sep).join('/');

export function mediaKind(path: string): 'image' | 'audio' | 'video' | null {
  const e = extOf(path);
  return IMAGE.has(e) ? 'image' : AUDIO.has(e) ? 'audio' : VIDEO.has(e) ? 'video' : null;
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface Platform {
  /** Перемещение в корзину ОС. В тестах заменяется заглушкой. */
  trash(abs: string): Promise<void>;
}

/** Файловые операции окна. Все пути приходят относительно корня проекта и не могут из него выйти. */
export class ProjectFiles {
  readonly root: string;
  private readonly platform: Platform | undefined;

  constructor(root: string, platform?: Platform) {
    this.root = resolve(root);
    this.platform = platform;
  }

  abs(rel: string): string {
    const abs = resolve(this.root, rel);
    if (!isInside(this.root, abs)) throw new Error(`Путь вне проекта: ${rel}`);
    return abs;
  }

  rel(abs: string): string {
    return toPosix(relative(this.root, abs));
  }

  list(dir: string): DirEntry[] {
    const base = this.abs(dir || '.');
    const ignored = loadGitignore(this.root);
    const out: DirEntry[] = [];
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (HIDDEN.has(e.name)) continue;
      const abs = join(base, e.name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue; // битая ссылка
      }
      const rel = this.rel(abs);
      const isDir = st.isDirectory();
      out.push({
        name: e.name,
        path: rel,
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : st.size,
        mtime: st.mtimeMs,
        ...(ALWAYS_IGNORED.has(e.name) || ignored(rel, isDir) ? { muted: true } : {}),
      });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  }

  read(rel: string): FileContent {
    const abs = this.abs(rel);
    const st = statSync(abs);
    if (st.isDirectory()) throw new Error(`${rel} — каталог`);
    const base = { path: toPosix(rel), size: st.size, mtime: st.mtimeMs };
    if (extOf(abs) === 'pdf') {
      if (st.size > MAX_MEDIA_BYTES) return { kind: 'binary', ...base };
      return { kind: 'pdf', ...base, dataUrl: `data:application/pdf;base64,${readFileSync(abs).toString('base64')}` };
    }
    const media = mediaKind(abs);
    if (media) {
      if (st.size > MAX_MEDIA_BYTES) return { kind: 'binary', ...base };
      const e = extOf(abs);
      const mime = (media === 'image' ? IMAGE : media === 'audio' ? AUDIO : VIDEO).get(e)!;
      return { kind: media, ...base, dataUrl: `data:${mime};base64,${readFileSync(abs).toString('base64')}` };
    }
    const buf = readFileSync(abs);
    if (looksBinary(buf)) return { kind: 'binary', ...base };
    const truncated = buf.length > MAX_TEXT_BYTES;
    return { kind: 'text', ...base, text: (truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf).toString('utf8'), ...(truncated ? { truncated: true } : {}) };
  }

  write(rel: string, text: string): { mtime: number } {
    const abs = this.abs(rel);
    if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error(`${rel} — каталог`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return { mtime: statSync(abs).mtimeMs };
  }

  create(rel: string, dir = false): void {
    const abs = this.abs(rel);
    if (existsSync(abs)) throw new Error(`${rel} уже существует`);
    if (dir) mkdirSync(abs, { recursive: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, '');
    }
  }

  rename(from: string, to: string): void {
    const a = this.abs(from);
    const b = this.abs(to);
    if (!existsSync(a)) throw new Error(`${from} не найден`);
    if (existsSync(b)) throw new Error(`${to} уже существует`);
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
  }

  async trash(rel: string): Promise<void> {
    const abs = this.abs(rel);
    if (abs === this.root) throw new Error('Нельзя удалить корень проекта');
    if (!existsSync(abs)) throw new Error(`${rel} не найден`);
    if (!this.platform) throw new Error('Корзина недоступна в этом окружении');
    await this.platform.trash(abs);
  }

  /** Поиск по имени (нечёткий: символы запроса идут по порядку) или по содержимому (подстрока без учёта регистра). */
  async search(query: string, mode: 'name' | 'content', limit = 200): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const files = walkFiles(this.root, this.root);
    if (mode === 'name') return rankByName(files, q).slice(0, 100).map((path) => ({ path }));
    const needle = q.toLowerCase();
    const hits: SearchHit[] = [];
    let n = 0;
    for (const rel of files) {
      if (++n % 40 === 0) await new Promise((r) => setImmediate(r));
      const abs = join(this.root, rel);
      let buf: Buffer;
      try {
        if (statSync(abs).size > MAX_TEXT_BYTES) continue;
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          hits.push({ path: rel, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  /**
   * HTML для предпросмотра: локальные стили, скрипты и картинки подставляются в сам файл, потому что iframe с srcdoc
   * не умеет ходить за файлами проекта. Подстановка поверхностная (теги link, script, img, без @import и url() в CSS):
   * для точной картины есть встроенный браузер.
   */
  previewHtml(rel: string): { html: string; inlined: string[]; missing: string[] } {
    const abs = this.abs(rel);
    const dir = dirname(abs);
    let html = readFileSync(abs, 'utf8');
    const inlined: string[] = [];
    const missing: string[] = [];
    const local = (ref: string): string | null => {
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(ref)) return null;
      try {
        const p = this.abs(this.rel(resolve(dir, decodeURIComponent(ref.split(/[?#]/)[0]!))));
        return p;
      } catch {
        return null;
      }
    };
    const read = (ref: string, limit: number): Buffer | null => {
      const p = local(ref);
      if (!p) return null;
      try {
        if (statSync(p).size > limit) return null;
        const b = readFileSync(p);
        inlined.push(this.rel(p));
        return b;
      } catch {
        missing.push(ref);
        return null;
      }
    };
    html = html.replace(/<link\b([^>]*?)>/gi, (tag, attrs: string) => {
      if (!/rel\s*=\s*["']?stylesheet/i.test(attrs)) return tag;
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const b = href ? read(href, 500_000) : null;
      return b ? `<style>${b.toString('utf8').replace(/<\/style/gi, '<\\/style')}</style>` : tag;
    });
    // предпросмотр статичный: скрипты не выполняются (изоляция и CSP окна), поэтому их не подставляем вовсе
    html = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
    html = html.replace(/<img\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi, (tag, a: string, src: string, b: string) => {
      const buf = read(src, 2_000_000);
      const mime = IMAGE.get(extOf(src.split(/[?#]/)[0]!));
      return buf && mime ? `<img${a}src="data:${mime};base64,${buf.toString('base64')}"${b}>` : tag;
    });
    return { html, inlined, missing };
  }

  gitStatus(): Promise<GitStatus | null> {
    return new Promise((res) => {
      execFile('git', ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal'], { cwd: this.root, timeout: 8000, maxBuffer: 8_000_000 }, (err, stdout) => {
        if (err) return res(null);
        res(parseGitStatus(stdout));
      });
    });
  }
}

export function rankByName(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = basename(lower);
    let s = -1;
    if (base === q) s = 0;
    else if (base.startsWith(q)) s = 1;
    else if (base.includes(q)) s = 2;
    else if (lower.includes(q)) s = 3;
    else if (isSubsequence(q, base)) s = 4;
    else if (isSubsequence(q, lower)) s = 5;
    if (s >= 0) scored.push({ f, s: s * 1000 + f.length });
  }
  return scored.sort((a, b) => a.s - b.s).map((x) => x.f);
}

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return true;
  return q.length === 0;
}

/** Разбор `git status --porcelain=v1 -b -z`: первая запись — ветка, дальше «XY путь», у переименований следом идёт старый путь. */
export function parseGitStatus(out: string): GitStatus {
  const parts = out.split('\0');
  let branch = '';
  const files: GitStatus['files'] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    if (p.startsWith('## ')) {
      branch = p.slice(3).split('...')[0]!.replace(/^No commits yet on /, '').replace(/^HEAD \(no branch\)/, 'HEAD');
      continue;
    }
    const status = p.slice(0, 2);
    const path = p.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i++;
    files.push({ path, status });
  }
  return { branch, files };
}
