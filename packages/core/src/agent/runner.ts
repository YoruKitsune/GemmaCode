import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentPart } from '../inference/backend.ts';
import { execCommand } from '../tools/shell.ts';
import type { Agent } from './loop.ts';
import type { AgentEvent } from './events.ts';
import { reviewChanges, reviewFeedback, type ReviewIssue } from './review.ts';

export interface RunOptions {
  /** Команда проверки (тесты, сборка). 'auto' — определить по проекту. Без неё режим loop не включается. */
  verify?: string;
  verifyTimeoutS?: number;
  /** Сколько раз всего можно запустить агента (первая попытка + исправления). */
  maxIterations?: number;
  /** Само-ревью собственных правок после успешной проверки. */
  review?: boolean;
  maxReviewRounds?: number;
  reviewMaxDiffChars?: number;
}

export type RunOutcome = 'verified' | 'completed' | 'max_iterations' | 'no_progress' | 'agent_stopped' | 'aborted';

export type RunnerEvent =
  | AgentEvent
  | { type: 'iteration'; n: number; max: number; reason: 'start' | 'verify_failed' | 'review_issues' }
  | { type: 'verify'; iteration: number; command: string; passed: boolean; exitCode: number | null; output: string }
  | { type: 'review'; round: number; verdict: 'ok' | 'issues' | 'skipped'; issues: ReviewIssue[]; dropped: number }
  | { type: 'run_done'; outcome: RunOutcome; iterations: number; reviewRounds: number };

/** Команда проверки по содержимому проекта; null, если ничего подходящего не нашли. */
export function detectVerifyCommand(cwd: string): string | null {
  const pkg = join(cwd, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      if (scripts.test && !/no test specified/.test(scripts.test)) return 'npm test';
    } catch {
      // package.json повреждён
    }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(cwd, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'pyproject.toml'))) return 'pytest -q';
  if (existsSync(join(cwd, 'test'))) return 'node --test';
  return null;
}

/**
 * Задача целиком: ход агента, затем проверка командой (режим loop) и само-ревью. Если проверка падает, её вывод
 * возвращается агенту как новое сообщение; цикл останавливается при успехе, исчерпании попыток или отсутствии прогресса.
 */
export async function* runTask(agent: Agent, input: string | ContentPart[], opts: RunOptions = {}, signal?: AbortSignal): AsyncGenerator<RunnerEvent> {
  const cwd = agent.ctx.cwd;
  const verifyCmd = opts.verify === 'auto' ? detectVerifyCommand(cwd) : opts.verify;
  const maxIter = Math.max(1, opts.maxIterations ?? (verifyCmd || opts.review ? 4 : 1));
  const maxReview = opts.review ? (opts.maxReviewRounds ?? 1) : 0;
  const snapshots = agent.ctx.snapshots;
  const firstCheckpoint = (snapshots?.list().length ?? 0) + 1;
  const taskText = typeof input === 'string' ? input : input.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join(' ');

  let prompt: string | ContentPart[] = input;
  let reason: 'start' | 'verify_failed' | 'review_issues' = 'start';
  let reviewRounds = 0;
  let prevFailure = '';
  let verifyNote = '';
  let iterations = 0;

  while (iterations < maxIter) {
    iterations++;
    yield { type: 'iteration', n: iterations, max: maxIter, reason };
    let stop: AgentEvent | undefined;
    let touched = 0;
    for await (const e of agent.send(prompt, signal)) {
      yield e;
      if (e.type === 'tool_result') touched += e.touched.length;
      if (e.type === 'done') stop = e;
    }
    if (stop?.type === 'done' && (stop.reason === 'aborted' || stop.reason === 'error')) {
      yield { type: 'run_done', outcome: stop.reason === 'aborted' ? 'aborted' : 'agent_stopped', iterations, reviewRounds };
      return;
    }

    if (verifyCmd) {
      const r = await execCommand(verifyCmd, { cwd, sandbox: agent.ctx.sandbox, timeoutS: opts.verifyTimeoutS ?? 120, maxOutputChars: 3000, ...(signal ? { signal } : {}) });
      const passed = r.exitCode === 0 && !r.timedOut;
      yield { type: 'verify', iteration: iterations, command: verifyCmd, passed, exitCode: r.exitCode, output: r.output };
      if (signal?.aborted) {
        yield { type: 'run_done', outcome: 'aborted', iterations, reviewRounds };
        return;
      }
      if (!passed) {
        const fp = createHash('sha1').update(r.output).digest('hex');
        if (fp === prevFailure && touched === 0) {
          yield { type: 'run_done', outcome: 'no_progress', iterations, reviewRounds };
          return;
        }
        prevFailure = fp;
        const why = r.timedOut ? 'timed out' : `exit code ${r.exitCode}`;
        prompt = `The check \`${verifyCmd}\` failed (${why}). Output:\n${r.output || '(no output)'}\n\nFix the problem so that the check passes. Change only what is needed.`;
        reason = 'verify_failed';
        continue;
      }
      verifyNote = `The check \`${verifyCmd}\` passes.`;
    }

    if (reviewRounds < maxReview && snapshots) {
      reviewRounds++;
      const diff = snapshots.diffSince(firstCheckpoint);
      if (!diff) {
        yield { type: 'review', round: reviewRounds, verdict: 'skipped', issues: [], dropped: 0 };
      } else {
        const res = await reviewChanges(agent.backend, { task: taskText, diff, verifyNote, ...(opts.reviewMaxDiffChars ? { maxDiffChars: opts.reviewMaxDiffChars } : {}) }, signal);
        yield { type: 'review', round: reviewRounds, verdict: res.verdict, issues: res.issues, dropped: res.dropped };
        if (res.issues.length) {
          prompt = reviewFeedback(res.issues);
          reason = 'review_issues';
          continue;
        }
      }
    }
    yield { type: 'run_done', outcome: verifyCmd ? 'verified' : 'completed', iterations, reviewRounds };
    return;
  }
  yield { type: 'run_done', outcome: 'max_iterations', iterations, reviewRounds };
}
