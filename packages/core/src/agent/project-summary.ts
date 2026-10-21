import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { walkFiles } from '../tools/glob.ts';

const LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.cc': 'C++', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.sh': 'Shell', '.html': 'HTML', '.css': 'CSS',
  '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
};

export interface ProjectSummary {
  /** Соглашения проекта, которые модель иначе угадывает неверно (система модулей и т. п.). */
  conventions: string[];
  tree: string[];
  languages: [string, number][];
  commands: string[];
  fileCount: number;
}

/** Свод проекта без участия модели: дерево, языки и команды сборки. Идёт в стабильный префикс промпта. */
export function summarizeProject(cwd: string, opts: { maxTreeLines?: number } = {}): ProjectSummary {
  const maxLines = opts.maxTreeLines ?? 40;
  const files = walkFiles(cwd, cwd, { maxFiles: 5000 });
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = LANG[extname(f).toLowerCase()];
    if (lang && lang !== 'JSON' && lang !== 'Markdown' && lang !== 'YAML' && lang !== 'TOML') counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return {
    conventions: detectConventions(cwd, files),
    tree: buildTree(files, maxLines),
    languages: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    commands: detectCommands(cwd),
    fileCount: files.length,
  };
}

/** Дерево до глубины 2; каталоги с большим числом файлов сворачиваются в счётчик. */
function buildTree(files: string[], maxLines: number): string[] {
  const top = new Map<string, { files: number; children: Set<string> }>();
  const rootFiles: string[] = [];
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) {
      rootFiles.push(f);
      continue;
    }
    const e = top.get(parts[0]!) ?? { files: 0, children: new Set<string>() };
    e.files++;
    e.children.add(parts.length === 2 ? parts[1]! : `${parts[1]}/`);
    top.set(parts[0]!, e);
  }
  const lines: string[] = [];
  for (const [dir, e] of top) {
    lines.push(`${dir}/ (${e.files} files)`);
    const kids = [...e.children].slice(0, 6);
    for (const k of kids) lines.push(`  ${k}`);
    if (e.children.size > kids.length) lines.push(`  … ${e.children.size - kids.length} more`);
  }
  lines.push(...rootFiles);
  return lines.length > maxLines ? [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more entries`] : lines;
}

function detectCommands(cwd: string): string[] {
  const out: string[] = [];
  const pkg = join(cwd, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const k of ['test', 'build', 'lint', 'typecheck', 'start', 'dev']) if (scripts[k]) out.push(`npm run ${k}${k === 'test' ? '' : ''}  (${truncate(scripts[k]!)})`);
    } catch {
      // package.json повреждён
    }
  }
  if (existsSync(join(cwd, 'Makefile'))) out.push('make');
  if (existsSync(join(cwd, 'Cargo.toml'))) out.push('cargo build', 'cargo test');
  if (existsSync(join(cwd, 'go.mod'))) out.push('go build ./...', 'go test ./...');
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'pytest.ini'))) out.push('pytest');
  return out.slice(0, 6);
}

/** Система модулей JavaScript и тестовый раннер: типичная причина «код написан не в том стиле». */
export function detectConventions(cwd: string, _files: string[] = []): string[] {
  const out: string[] = [];
  // Подсказка нужна и пустому проекту: именно там модель по умолчанию выбирает CommonJS.
  const pkg = join(cwd, 'package.json');
  if (existsSync(pkg)) {
    try {
      const p = JSON.parse(readFileSync(pkg, 'utf8')) as { type?: string; scripts?: Record<string, string> };
      out.push(p.type === 'module' ? 'JavaScript uses ES modules: write import/export, never require/module.exports; local imports need the .js extension.' : 'JavaScript uses CommonJS (require / module.exports) unless a file is .mjs.');
      const test = p.scripts?.test ?? '';
      if (/node\s+--test/.test(test)) out.push('Tests use the node:test runner and node:assert.');
    } catch {
      // package.json повреждён
    }
  }
  return out;
}

const truncate = (s: string): string => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

export function formatSummary(s: ProjectSummary): string {
  const parts = [`Project files (${s.fileCount}):`, ...s.tree.map((l) => l)];
  if (s.conventions.length) parts.push(...s.conventions);
  if (s.languages.length) parts.push(`Languages: ${s.languages.map(([l, n]) => `${l} (${n})`).join(', ')}`);
  if (s.commands.length) parts.push(`Commands: ${s.commands.join('; ')}`);
  return parts.join('\n');
}
