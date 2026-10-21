import { rmSync } from 'node:fs';
import {
  Agent,
  PermissionPolicy,
  SnapshotStore,
  createRegistry,
  detectSandbox,
  runTask,
  type InferenceBackend,
  type RunOutcome,
  type SandboxRunner,
  type SkillRouting,
  type ToolCallMode,
} from '@gemmacode/core';
import { materialize, verifyTask } from './materialize.ts';
import type { Category, EvalTask } from './types.ts';

export interface EvalOptions {
  backend: InferenceBackend;
  tasks: EvalTask[];
  toolCallMode?: ToolCallMode;
  /** Режим loop: после хода агента запускается проверка и при падении агент получает её вывод. */
  loop?: boolean;
  /** Само-ревью собственных правок. */
  review?: boolean;
  maxIterations?: number;
  maxSteps?: number;
  contextSize?: number;
  skillRouting?: SkillRouting;
  sandbox?: SandboxRunner;
  keepDirs?: boolean;
  log?: (line: string) => void;
}

export interface TaskResult {
  id: string;
  suite: string;
  category: Category;
  passed: boolean;
  outcome: RunOutcome | 'crashed';
  doneReason: string;
  iterations: number;
  reviewRounds: number;
  reviewIssues: number;
  steps: number;
  toolCalls: number;
  invalidCalls: number;
  fallbacks: number;
  promptTokens: number;
  generatedTokens: number;
  tokensPerSecond: number;
  seconds: number;
  failure?: string;
  dir?: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  rate: number;
  byCategory: Record<string, { n: number; passed: number }>;
  bySuite: Record<string, { n: number; passed: number }>;
  invalidCallRate: number;
  avgSeconds: number;
  avgTokensPerSecond: number;
  fallbacks: number;
}

/**
 * Проверка, которую пользователь мог бы задать сам, не зная скрытых тестов: видимые тесты либо проверка синтаксиса.
 * `node --check a b` проверяет только первый файл, поэтому файлы проверяются по одному, а первая ошибка даёт код 1.
 */
export const SYNTAX_CHECK =
  "find . -name '*.js' -not -path './node_modules/*' -not -path './test/*' -not -path './.gemmacode/*' | while read -r f; do node --check \"$f\" || exit 1; done";

export function loopVerifyFor(task: EvalTask): string {
  return task.showTests ? (task.verify ?? 'node --test') : SYNTAX_CHECK;
}

export async function runEval(o: EvalOptions): Promise<{ results: TaskResult[]; summary: EvalSummary }> {
  const log = o.log ?? (() => {});
  const sandbox = o.sandbox ?? detectSandbox();
  const results: TaskResult[] = [];
  for (const [i, task] of o.tasks.entries()) {
    const dir = materialize(task);
    const t0 = Date.now();
    const base = { id: task.id, suite: task.suite, category: task.category };
    let result: TaskResult;
    try {
      const snapshots = new SnapshotStore(dir, 'eval');
      const agent = new Agent({
        backend: o.backend,
        cwd: dir,
        registry: createRegistry('edit', { skills: false }),
        policy: new PermissionPolicy({ mode: 'full', cwd: dir, sandboxEnforced: sandbox.enforced }),
        sandbox,
        snapshots,
        toolCallMode: o.toolCallMode ?? 'native',
        skillRouting: o.skillRouting ?? 'model',
        ...(o.contextSize ? { contextSize: o.contextSize } : {}),
        ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}),
      });
      let outcome: RunOutcome = 'completed';
      let iterations = 0;
      let reviewRounds = 0;
      let reviewIssues = 0;
      let fallbacks = 0;
      let doneReason = '';
      let failure: string | undefined;
      for await (const e of runTask(agent, task.prompt, {
        ...(o.loop ? { verify: loopVerifyFor(task) } : {}),
        ...(o.review ? { review: true } : {}),
        ...(o.maxIterations ? { maxIterations: o.maxIterations } : {}),
      })) {
        if (e.type === 'done') {
          doneReason = e.reason;
          if (e.reason === 'error') failure = e.message;
        }
        if (e.type === 'fallback') fallbacks++;
        if (e.type === 'review') reviewIssues += e.issues.length;
        if (e.type === 'run_done') {
          outcome = e.outcome;
          iterations = e.iterations;
          reviewRounds = e.reviewRounds;
        }
      }
      const verdict = await verifyTask(task, dir, sandbox);
      result = {
        ...base,
        passed: verdict.passed,
        outcome,
        doneReason,
        iterations,
        reviewRounds,
        reviewIssues,
        steps: agent.stats.steps,
        toolCalls: agent.stats.toolCalls,
        invalidCalls: agent.stats.invalidCalls,
        fallbacks,
        promptTokens: agent.stats.promptTokens,
        generatedTokens: agent.stats.generatedTokens,
        tokensPerSecond: agent.stats.genTokensPerSecond,
        seconds: (Date.now() - t0) / 1000,
        ...(verdict.passed ? {} : { failure: failure ?? verdict.output.split('\n').slice(0, 12).join('\n') }),
        ...(o.keepDirs ? { dir } : {}),
      };
    } catch (e) {
      result = {
        ...base, passed: false, outcome: 'crashed', doneReason: 'crashed', iterations: 0, reviewRounds: 0, reviewIssues: 0, steps: 0, toolCalls: 0, invalidCalls: 0, fallbacks: 0,
        promptTokens: 0, generatedTokens: 0, tokensPerSecond: 0, seconds: (Date.now() - t0) / 1000, failure: (e as Error).message,
      };
    }
    if (!o.keepDirs) rmSync(dir, { recursive: true, force: true });
    results.push(result);
    log(`[${i + 1}/${o.tasks.length}] ${result.passed ? 'PASS' : 'FAIL'} ${task.id} (${result.steps} steps, ${result.toolCalls} calls, ${result.invalidCalls} invalid, ${result.seconds.toFixed(0)}s)`);
  }
  return { results, summary: summarize(results) };
}

export function summarize(results: TaskResult[]): EvalSummary {
  const by = (key: 'category' | 'suite') => {
    const out: Record<string, { n: number; passed: number }> = {};
    for (const r of results) {
      const e = (out[r[key]] ??= { n: 0, passed: 0 });
      e.n++;
      if (r.passed) e.passed++;
    }
    return out;
  };
  const calls = results.reduce((n, r) => n + r.toolCalls, 0);
  const invalid = results.reduce((n, r) => n + r.invalidCalls, 0);
  const speeds = results.filter((r) => r.tokensPerSecond > 0).map((r) => r.tokensPerSecond);
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    rate: results.length ? passed / results.length : 0,
    byCategory: by('category'),
    bySuite: by('suite'),
    invalidCallRate: calls ? invalid / calls : 0,
    avgSeconds: results.length ? results.reduce((n, r) => n + r.seconds, 0) / results.length : 0,
    fallbacks: results.reduce((n, r) => n + r.fallbacks, 0),
    avgTokensPerSecond: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
  };
}

export function renderReport(label: string, config: Record<string, unknown>, results: TaskResult[], summary: EvalSummary): string {
  const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : '—');
  const lines = [
    `# Оценка агента: ${label}`,
    '',
    `Конфигурация: ${Object.entries(config).map(([k, v]) => `${k}=${String(v)}`).join(', ')}`,
    '',
    `**Итого: ${pct(summary.passed, summary.total)}.** Невалидных вызовов инструментов: ${(summary.invalidCallRate * 100).toFixed(1)}%. Среднее время на задачу: ${summary.avgSeconds.toFixed(0)} с, средняя скорость генерации ${summary.avgTokensPerSecond.toFixed(1)} ток/с.`,
    '',
    `Откатов на schema после ошибки разбора вызова: ${summary.fallbacks}.`,
    '',
    '| Набор | Решено |',
    '|---|---|',
    ...Object.entries(summary.bySuite).map(([k, v]) => `| ${k} | ${pct(v.passed, v.n)} |`),
    '',
    '| Категория | Решено |',
    '|---|---|',
    ...Object.entries(summary.byCategory).map(([k, v]) => `| ${k} | ${pct(v.passed, v.n)} |`),
    '',
  ];
  const edit = summary.bySuite.edit30;
  if (edit) lines.push(`Гейт M1 (20 из 30 на правку кода): ${edit.passed >= 20 && edit.n === 30 ? 'пройден' : edit.n < 30 ? 'не оценивался полностью' : 'не пройден'} (${edit.passed}/${edit.n}).`, '');
  lines.push('| Задача | Итог | Шаги | Вызовы | Невалидных | Откатов | Итераций | Время, с | Причина остановки |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of results) lines.push(`| ${r.id} | ${r.passed ? 'да' : 'нет'} | ${r.steps} | ${r.toolCalls} | ${r.invalidCalls} | ${r.fallbacks} | ${r.iterations} | ${r.seconds.toFixed(0)} | ${r.doneReason} |`);
  const failed = results.filter((r) => !r.passed && r.failure);
  if (failed.length) {
    lines.push('', '## Провалы', '');
    for (const r of failed) lines.push(`**${r.id}** (${r.doneReason})`, '```', (r.failure ?? '').slice(0, 600), '```', '');
  }
  return lines.join('\n');
}
