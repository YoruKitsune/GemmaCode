import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { walkFiles } from '@gemmacode/core';
import type { DayStat, LanguageStat, ProjectStats, TurnStat } from '@gemmacode/protocol';

const LANGS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', lua: 'Lua', dart: 'Dart',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'CSS', less: 'CSS', vue: 'Vue', svelte: 'Svelte',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', sql: 'SQL',
  md: 'Markdown', markdown: 'Markdown', txt: 'Text',
};
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;

/** Размер и языки кода: считается по файлам проекта (без .gitignore-ных, node_modules и т. п.), без обращения к модели. */
export function scanCode(cwd: string): ProjectStats['code'] {
  const files = walkFiles(cwd, cwd, { maxFiles: MAX_FILES + 1 });
  const truncated = files.length > MAX_FILES;
  const byLang = new Map<string, LanguageStat>();
  let lines = 0;
  let bytes = 0;
  let counted = 0;
  for (const rel of files.slice(0, MAX_FILES)) {
    const lang = LANGS[extname(rel).slice(1).toLowerCase()];
    if (!lang) continue;
    const abs = join(cwd, rel);
    try {
      const st = statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const text = readFileSync(abs, 'utf8');
      let n = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      if (text.length && !text.endsWith('\n')) n++;
      lines += n;
      bytes += st.size;
      counted++;
      const cur = byLang.get(lang) ?? { name: lang, files: 0, lines: 0 };
      cur.files++;
      cur.lines += n;
      byLang.set(lang, cur);
    } catch {
      // файл исчез или не читается
    }
  }
  return { files: counted, lines, bytes, languages: [...byLang.values()].sort((a, b) => b.lines - a.lines), truncated };
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 8000, maxBuffer: 16_000_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function numstat(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (m) {
      added += Number(m[1]);
      removed += Number(m[2]);
    }
  }
  return { added, removed };
}

export async function gitActivity(cwd: string): Promise<ProjectStats['git']> {
  const empty = { isRepo: false, commits30: 0, added30: 0, removed30: 0, uncommittedAdded: 0, uncommittedRemoved: 0 };
  if (!existsSync(join(cwd, '.git'))) return empty;
  const log = await git(cwd, ['log', '--since=30.days', '--numstat', '--format=%x00commit']);
  if (log === null) return { ...empty, isRepo: true };
  const { added, removed } = numstat(log);
  const commits = (log.match(/\0commit/g) ?? []).length;
  const diff = (await git(cwd, ['diff', 'HEAD', '--numstat'])) ?? '';
  const u = numstat(diff);
  return { isRepo: true, commits30: commits, added30: added, removed30: removed, uncommittedAdded: u.added, uncommittedRemoved: u.removed };
}

export interface TurnRecord {
  ts: number;
  session: string;
  model: string | null;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  invalidCalls: number;
  promptTokens: number;
  /** Токены промпта из кэша префикса (сумма cache_n по шагам хода). */
  cachedTokens: number;
  generatedTokens: number;
  /** Спекулятивный декодинг: токены черновика и принятые (суммы draft_n и draft_n_accepted). */
  draftTokens: number;
  draftAccepted: number;
  genTps: number;
  ttftMs: number;
  durationMs: number;
  added: number;
  removed: number;
  outcome: string;
  rssMB: number | null;
  tools: Record<string, { calls: number; errors: number }>;
}

/** Строки «+» и «−» в unified diff, без заголовков. */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) continue;
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { added, removed };
}

const dayOf = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Db = import('node:sqlite').DatabaseSync;

/** Статистика ходов агента в SQLite проекта (`.gemmacode/stats.db`). Всё локально, наружу ничего не уходит. */
export class StatsStore {
  private db: Db | undefined;
  private error: string | undefined;
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private open(): Db | undefined {
    if (this.db || this.error) return this.db;
    try {
      // node:sqlite есть в Node 22.5+ (в Electron 45 это Node 24); на старых версиях статистика ходов просто выключена
      const { DatabaseSync } = require_sqlite();
      mkdirSync(join(this.cwd, '.gemmacode'), { recursive: true });
      const db = new DatabaseSync(join(this.cwd, '.gemmacode', 'stats.db'));
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT, model TEXT, steps INTEGER,
          tool_calls INTEGER, tool_errors INTEGER, invalid_calls INTEGER, prompt_tokens INTEGER, generated_tokens INTEGER,
          gen_tps REAL, ttft_ms INTEGER, duration_ms INTEGER, added INTEGER, removed INTEGER, outcome TEXT, rss_mb INTEGER);
        CREATE TABLE IF NOT EXISTS tool_stats (turn_id INTEGER NOT NULL, name TEXT NOT NULL, calls INTEGER NOT NULL, errors INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS turns_ts ON turns (ts);
      `);
      // базы M3 без этих столбцов дополняем; старые строки получают 0
      const have = new Set((db.prepare('PRAGMA table_info(turns)').all() as unknown as { name: string }[]).map((c) => c.name));
      for (const col of ['cached_tokens', 'draft_tokens', 'draft_accepted']) if (!have.has(col)) db.exec(`ALTER TABLE turns ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      this.db = db;
    } catch (e) {
      this.error = (e as Error).message;
    }
    return this.db;
  }

  recordTurn(r: TurnRecord): void {
    const db = this.open();
    if (!db) return;
    try {
      const res = db
        .prepare(
          `INSERT INTO turns (ts, session, model, steps, tool_calls, tool_errors, invalid_calls, prompt_tokens, cached_tokens, generated_tokens, draft_tokens, draft_accepted, gen_tps, ttft_ms, duration_ms, added, removed, outcome, rss_mb)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.ts, r.session, r.model, r.steps, r.toolCalls, r.toolErrors, r.invalidCalls, r.promptTokens, r.cachedTokens, r.generatedTokens, r.draftTokens, r.draftAccepted, r.genTps, r.ttftMs, r.durationMs, r.added, r.removed, r.outcome, r.rssMB);
      const ins = db.prepare('INSERT INTO tool_stats (turn_id, name, calls, errors) VALUES (?, ?, ?, ?)');
      for (const [name, v] of Object.entries(r.tools)) ins.run(Number(res.lastInsertRowid), name, v.calls, v.errors);
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  agentStats(speculative = 'none'): { stats: ProjectStats['agent']; dbError?: string } {
    const empty: ProjectStats['agent'] = {
      turns: 0, promptTokens: 0, generatedTokens: 0, avgGenTps: 0, avgTtftMs: 0, cachedTokens: 0, cacheHitRate: 0, draftTokens: 0, draftAccepted: 0, acceptRate: 0, speculative, toolCalls: 0, toolErrors: 0, invalidCalls: 0, toolSuccess: 1,
      added: 0, removed: 0, byDay: [], recent: [], tools: [], modelRssMB: null, modelName: null,
    };
    const db = this.open();
    if (!db) return { stats: empty, ...(this.error ? { dbError: this.error } : {}) };
    const rows = db.prepare('SELECT * FROM turns ORDER BY ts').all() as unknown as {
      ts: number; model: string | null; tool_calls: number; tool_errors: number; invalid_calls: number; prompt_tokens: number; cached_tokens: number; generated_tokens: number; draft_tokens: number; draft_accepted: number;
      gen_tps: number; ttft_ms: number; added: number; removed: number; rss_mb: number | null;
    }[];
    let genTime = 0;
    let genTok = 0;
    let ttft = 0;
    let ttftN = 0;
    const days = new Map<string, DayStat>();
    for (const r of rows) {
      empty.promptTokens += r.prompt_tokens;
      empty.generatedTokens += r.generated_tokens;
      empty.cachedTokens += r.cached_tokens;
      empty.draftTokens += r.draft_tokens;
      empty.draftAccepted += r.draft_accepted;
      empty.toolCalls += r.tool_calls;
      empty.toolErrors += r.tool_errors;
      empty.invalidCalls += r.invalid_calls;
      empty.added += r.added;
      empty.removed += r.removed;
      if (r.gen_tps > 0 && r.generated_tokens > 0) {
        genTok += r.generated_tokens;
        genTime += r.generated_tokens / r.gen_tps;
      }
      if (r.ttft_ms > 0) {
        ttft += r.ttft_ms;
        ttftN++;
      }
      const d = dayOf(r.ts);
      const cur = days.get(d) ?? { day: d, added: 0, removed: 0, turns: 0 };
      cur.added += r.added;
      cur.removed += r.removed;
      cur.turns++;
      days.set(d, cur);
      if (r.rss_mb) empty.modelRssMB = r.rss_mb;
      if (r.model) empty.modelName = r.model;
    }
    empty.turns = rows.length;
    empty.avgGenTps = genTime > 0 ? genTok / genTime : 0;
    empty.avgTtftMs = ttftN ? ttft / ttftN : 0;
    const promptAll = empty.promptTokens + empty.cachedTokens;
    empty.cacheHitRate = promptAll ? empty.cachedTokens / promptAll : 0;
    empty.acceptRate = empty.draftTokens ? empty.draftAccepted / empty.draftTokens : 0;
    const calls = empty.toolCalls;
    empty.toolSuccess = calls ? Math.max(0, (calls - empty.toolErrors - empty.invalidCalls) / calls) : 1;
    empty.byDay = fillDays(days, 30);
    empty.recent = rows.slice(-60).map((r): TurnStat => ({ ts: r.ts, genTps: r.gen_tps, ttftMs: r.ttft_ms, generatedTokens: r.generated_tokens, promptTokens: r.prompt_tokens, cachedTokens: r.cached_tokens, toolCalls: r.tool_calls, toolErrors: r.tool_errors }));
    empty.tools = (db.prepare('SELECT name, SUM(calls) AS calls, SUM(errors) AS errors FROM tool_stats GROUP BY name ORDER BY calls DESC').all() as unknown as { name: string; calls: number; errors: number }[]).map((t) => ({ name: t.name, calls: Number(t.calls), errors: Number(t.errors) }));
    return { stats: empty };
  }

  turnsCsv(): string {
    const db = this.open();
    if (!db) return '';
    const rows = db.prepare('SELECT * FROM turns ORDER BY ts').all() as unknown as Record<string, unknown>[];
    const cols = ['ts', 'session', 'model', 'steps', 'tool_calls', 'tool_errors', 'invalid_calls', 'prompt_tokens', 'cached_tokens', 'generated_tokens', 'draft_tokens', 'draft_accepted', 'gen_tps', 'ttft_ms', 'duration_ms', 'added', 'removed', 'outcome', 'rss_mb'];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'ts' ? new Date(Number(r.ts)).toISOString() : r[c])).join(','))].join('\n') + '\n';
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // уже закрыта
    }
    this.db = undefined;
  }
}

function fillDays(days: Map<string, DayStat>, n: number): DayStat[] {
  const out: DayStat[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    const d = dayOf(now - i * 86_400_000);
    out.push(days.get(d) ?? { day: d, added: 0, removed: 0, turns: 0 });
  }
  return out;
}

// createRequire нужен, чтобы подгрузить node:sqlite лениво и не падать при старте на Node без этого модуля
import { createRequire } from 'node:module';
function require_sqlite(): typeof import('node:sqlite') {
  return createRequire(import.meta.url)('node:sqlite');
}

export async function collectStats(cwd: string, store: StatsStore, speculative = 'none'): Promise<ProjectStats> {
  const [git, agent] = await Promise.all([gitActivity(cwd), Promise.resolve(store.agentStats(speculative))]);
  return { ...(agent.dbError ? { dbError: agent.dbError } : {}), code: scanCode(cwd), git, agent: agent.stats };
}
