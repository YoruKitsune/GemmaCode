import { mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { truncateMiddle } from '../context/truncate.ts';
import { displayPath, resolveUserPath } from './paths.ts';
import { globToRegExp, walkFiles, ALWAYS_IGNORED } from './glob.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 24_000;
const MAX_LIST = 200;
const MAX_GLOB = 200;
const MAX_GREP = 100;
const MAX_GREP_FILE_BYTES = 1_000_000;

const err = (content: string): ToolResult => ({ content, isError: true });

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function readText(abs: string): { ok: true; text: string } | { ok: false; error: string } {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, error: `File not found: ${abs}` };
  }
  if (st.isDirectory()) return { ok: false, error: `${abs} is a directory; use list_dir.` };
  if (st.size > 5_000_000) return { ok: false, error: `File is too large (${st.size} bytes). Use grep or read with offset/limit is not possible for files this big.` };
  const buf = readFileSync(abs);
  if (looksBinary(buf)) return { ok: false, error: `${abs} is a binary file. Attach it to the chat instead of reading it as text.` };
  return { ok: true, text: buf.toString('utf8') };
}

export const readFile: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description: 'Read a text file. For long files pass offset (first line, from 1) and limit (number of lines).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root' },
      offset: { type: 'integer', description: 'First line to read, starting at 1' },
      limit: { type: 'integer', description: 'Number of lines to read' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  risk: 'read',
  inspect: (a, ctx) => {
    const abs = resolveUserPath(ctx.cwd, a.path);
    return { summary: `read ${displayPath(ctx.cwd, abs)}`, paths: [abs] };
  },
  async run(a, ctx) {
    const abs = resolveUserPath(ctx.cwd, a.path);
    const r = readText(abs);
    if (!r.ok) return err(r.error);
    const lines = r.text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, a.offset ?? 1);
    const limit = Math.min(a.limit ?? MAX_READ_LINES, MAX_READ_LINES);
    const slice = lines.slice(start - 1, start - 1 + limit);
    let body = slice.join('\n');
    let shownEnd = start - 1 + slice.length;
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS);
      shownEnd = start - 1 + body.split('\n').length - 1;
    }
    if (start === 1 && shownEnd >= lines.length) return { content: body };
    const note = shownEnd < lines.length ? ` Continue with offset=${shownEnd + 1}.` : '';
    return { content: `[lines ${start}-${shownEnd} of ${lines.length}]${note}\n${body}` };
  },
};

export const writeFile: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description: 'Create a file or overwrite it completely. Prefer edit_file for small changes to existing files.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Full file content' } },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  risk: 'write',
  inspect: (a, ctx) => {
    const abs = resolveUserPath(ctx.cwd, a.path);
    return { summary: `write ${displayPath(ctx.cwd, abs)} (${a.content.split('\n').length} lines)`, paths: [abs] };
  },
  async run(a, ctx) {
    const abs = resolveUserPath(ctx.cwd, a.path);
    let existed = true;
    try {
      if (statSync(abs).isDirectory()) return err(`${a.path} is a directory.`);
    } catch {
      existed = false;
    }
    ctx.snapshots?.record(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, a.content);
    return { content: `${existed ? 'Overwrote' : 'Created'} ${displayPath(ctx.cwd, abs)} (${a.content.split('\n').length} lines).`, touched: [abs] };
  },
};

interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editFile: Tool<EditArgs> = {
  name: 'edit_file',
  description: 'Replace exact text in a file. old_string must match the file text once (copy it from read_file output, keep indentation).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  risk: 'write',
  inspect: (a, ctx) => {
    const abs = resolveUserPath(ctx.cwd, a.path);
    return { summary: `edit ${displayPath(ctx.cwd, abs)}`, paths: [abs] };
  },
  async run(a, ctx) {
    const abs = resolveUserPath(ctx.cwd, a.path);
    const r = readText(abs);
    if (!r.ok) return err(r.error);
    if (a.old_string === '') return err('old_string is empty. To create or fully replace a file use write_file.');
    if (a.old_string === a.new_string) return err('old_string and new_string are identical; nothing to change.');
    const crlf = r.text.includes('\r\n');
    const text = crlf ? r.text.replace(/\r\n/g, '\n') : r.text;
    const oldS = a.old_string.replace(/\r\n/g, '\n');
    const newS = a.new_string.replace(/\r\n/g, '\n');

    const found = applyEdit(text, oldS, newS, a.replace_all === true);
    if (!found.ok) return err(`${found.error} (${displayPath(ctx.cwd, abs)})`);
    ctx.snapshots?.record(abs);
    writeFileSync(abs, crlf ? found.text.replace(/\n/g, '\r\n') : found.text);
    const note = found.fuzzy ? ' (matched ignoring indentation differences)' : '';
    return { content: `Edited ${displayPath(ctx.cwd, abs)}: ${found.count} replacement${found.count > 1 ? 's' : ''}${note}.`, touched: [abs] };
  },
};

type EditOutcome = { ok: true; text: string; count: number; fuzzy: boolean } | { ok: false; error: string };

/** Точная замена; если точного совпадения нет, ищем с поправкой на отступы и концевые пробелы. */
export function applyEdit(text: string, oldS: string, newS: string, all: boolean): EditOutcome {
  const exact = countOccurrences(text, oldS);
  if (exact === 1 || (exact > 1 && all)) {
    return { ok: true, text: all ? text.split(oldS).join(newS) : replaceOnce(text, oldS, newS), count: all ? exact : 1, fuzzy: false };
  }
  if (exact > 1) return { ok: false, error: `old_string occurs ${exact} times. Add more surrounding lines to make it unique, or set replace_all to true.` };

  // Построчное сравнение без учёта отступов и пробелов на концах строк.
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const oldLines = oldS.split('\n');
  while (oldLines.length > 1 && oldLines[oldLines.length - 1]!.trim() === '') oldLines.pop();
  const lines = text.split('\n');
  const hits: number[] = [];
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (norm(lines[i + j]!) !== norm(oldLines[j]!)) {
        match = false;
        break;
      }
    }
    if (match) hits.push(i);
  }
  if (hits.length === 0) return { ok: false, error: 'old_string was not found. Read the file again and copy the text exactly, including indentation.' };
  if (hits.length > 1 && !all) return { ok: false, error: `old_string matches ${hits.length} places ignoring indentation. Add more surrounding lines to make it unique.` };

  const newLines = newS.split('\n');
  const out = [...lines];
  for (const i of [...hits].reverse()) {
    // Соответствие «отступ в ответе модели -> отступ в файле» берём из совпавших строк и применяем к новому тексту.
    const indentMap = new Map<number, string>();
    for (let j = 0; j < oldLines.length; j++) {
      if (oldLines[j]!.trim() !== '') indentMap.set(/^\s*/.exec(oldLines[j]!)![0].length, /^\s*/.exec(lines[i + j]!)![0]);
    }
    const shifted = newLines.map((l) => (l.trim() === '' ? l : mapIndent(l, indentMap)));
    out.splice(i, oldLines.length, ...shifted);
  }
  return { ok: true, text: out.join('\n'), count: hits.length, fuzzy: true };
}

function mapIndent(line: string, indentMap: Map<number, string>): string {
  const n = /^\s*/.exec(line)![0].length;
  const exact = indentMap.get(n);
  if (exact !== undefined) return exact + line.slice(n);
  let best = -1;
  for (const k of indentMap.keys()) if (k < n && k > best) best = k;
  if (best < 0) return line;
  return indentMap.get(best)! + ' '.repeat(n - best) + line.slice(n);
}

function countOccurrences(text: string, sub: string): number {
  let n = 0;
  for (let i = text.indexOf(sub); i >= 0; i = text.indexOf(sub, i + sub.length)) n++;
  return n;
}

function replaceOnce(text: string, oldS: string, newS: string): string {
  const i = text.indexOf(oldS);
  return text.slice(0, i) + newS + text.slice(i + oldS.length);
}

export const listDir: Tool<{ path?: string }> = {
  name: 'list_dir',
  description: 'List files and folders in a directory. Folders end with "/".',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path, "." for the project root' } },
    additionalProperties: false,
  },
  risk: 'read',
  inspect: (a, ctx) => {
    const abs = resolveUserPath(ctx.cwd, a.path || '.');
    return { summary: `list ${displayPath(ctx.cwd, abs) || '.'}`, paths: [abs] };
  },
  async run(a, ctx) {
    const abs = resolveUserPath(ctx.cwd, a.path || '.');
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return err(`Directory not found: ${a.path || '.'}`);
    }
    const names = entries
      .filter((e) => e.name !== '.git' && e.name !== '.gemmacode')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((x, y) => (x.endsWith('/') === y.endsWith('/') ? (x < y ? -1 : 1) : x.endsWith('/') ? -1 : 1));
    if (names.length === 0) return { content: '(empty directory)' };
    const shown = names.slice(0, MAX_LIST);
    return { content: shown.join('\n') + (names.length > shown.length ? `\n[... ${names.length - shown.length} more entries ...]` : '') };
  },
};

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: 'glob',
  description: 'Find files by glob pattern, for example "**/*.ts" or "src/**/test_*.py".',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern such as **/*.ts' },
      path: { type: 'string', description: 'Directory to search in, optional' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  risk: 'read',
  inspect: (a, ctx) => {
    const abs = resolveUserPath(ctx.cwd, a.path || '.');
    return { summary: `glob ${a.pattern}`, paths: [abs] };
  },
  async run(a, ctx) {
    const base = resolveUserPath(ctx.cwd, a.path || '.');
    // Шаблон без «/» ищется на любой глубине, как в привычных инструментах.
    const pattern = a.pattern.includes('/') ? a.pattern.replace(/^\.\//, '') : `**/${a.pattern}`;
    const re = globToRegExp(pattern);
    const files = walkFiles(base, base).filter((f) => re.test(f));
    if (files.length === 0) return { content: 'No files matched.' };
    const shown = files.slice(0, MAX_GLOB).map((f) => displayPath(ctx.cwd, join(base, f)));
    return { content: shown.join('\n') + (files.length > shown.length ? `\n[... ${files.length - shown.length} more ...]` : '') };
  },
};

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
}

export const grep: Tool<GrepArgs> = {
  name: 'grep',
  description: 'Search file contents with a regular expression. Prints file:line: text.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex to search for' },
      path: { type: 'string', description: 'Directory or file, optional' },
      glob: { type: 'string', description: 'Only search files matching this glob, optional' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  risk: 'read',
  inspect: (a, ctx) => {
    const abs = resolveUserPath(ctx.cwd, a.path || '.');
    return { summary: `grep ${a.pattern}`, paths: [abs] };
  },
  async run(a, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
    } catch (e) {
      return err(`Invalid regular expression: ${(e as Error).message}`);
    }
    const base = resolveUserPath(ctx.cwd, a.path || '.');
    const globRe = a.glob ? globToRegExp(a.glob.includes('/') ? a.glob : `**/${a.glob}`) : null;
    const out: string[] = [];
    let total = 0;
    for (const rel of walkFiles(ctx.cwd, base)) {
      if (globRe && !globRe.test(rel)) continue;
      const abs = join(ctx.cwd, rel);
      let buf: Buffer;
      try {
        if (statSync(abs).size > MAX_GREP_FILE_BYTES) continue;
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          total++;
          if (out.length < MAX_GREP) out.push(`${rel}:${i + 1}: ${truncateMiddle(lines[i]!.trim(), 240)}`);
        }
      }
    }
    if (total === 0) return { content: 'No matches.' };
    return { content: out.join('\n') + (total > out.length ? `\n[... ${total - out.length} more matches; narrow the pattern or path ...]` : '') };
  },
};

export { ALWAYS_IGNORED };
export type { ToolContext };
