import type { InferenceBackend } from '../inference/backend.ts';
import { truncateMiddle } from '../context/truncate.ts';

export interface ReviewIssue {
  file: string;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  /** Строка из diff, на которую указывает замечание. Замечания без подтверждения цитатой отбрасываются. */
  evidence: string;
}

export interface ReviewResult {
  verdict: 'ok' | 'issues';
  issues: ReviewIssue[];
  /** Сколько замечаний отфильтровано как необоснованные (низкая важность или цитаты нет в diff). */
  dropped: number;
}

const SYSTEM =
  'You are a strict code reviewer. You get a task and the diff that was made for it. ' +
  'Report only real defects: bugs, requirements from the task that the diff does not satisfy, broken edge cases, leftover debug code. ' +
  'Do not report style or naming. For every issue quote the exact offending line from the diff in "evidence". ' +
  'If the diff correctly solves the task, answer verdict "ok" with an empty list.';

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['ok', 'issues'] },
    issues: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          severity: { enum: ['high', 'medium', 'low'] },
          problem: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['file', 'severity', 'problem', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'issues'],
  additionalProperties: false,
} as const;

/**
 * Само-ревью: модель в свежем контексте (задача и diff, без истории агента) проверяет собственные правки.
 * Ответ ограничен JSON-схемой, а замечания без цитаты из diff отбрасываются: маленькая модель склонна придумывать проблемы.
 */
export async function reviewChanges(
  backend: InferenceBackend,
  input: { task: string; diff: string; verifyNote?: string; maxDiffChars?: number },
  signal?: AbortSignal,
): Promise<ReviewResult> {
  const diff = truncateMiddle(input.diff, input.maxDiffChars ?? 6000);
  const user = `Task:\n${input.task.slice(0, 1500)}\n\n${input.verifyNote ? `${input.verifyNote}\n\n` : ''}Diff:\n${diff}`;
  let text = '';
  for await (const c of backend.chat(
    { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], jsonSchema: REVIEW_SCHEMA as unknown as Record<string, unknown>, maxTokens: 500, temperature: 0 },
    signal,
  )) {
    if (c.type === 'text') text += c.delta;
  }
  return parseReview(text, input.diff);
}

export function parseReview(text: string, diff: string): ReviewResult {
  let raw: { verdict?: string; issues?: Partial<ReviewIssue>[] };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return { verdict: 'ok', issues: [], dropped: 0 };
  }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const diffLines = diff.split('\n').map((l) => norm(l.replace(/^[+\- ]/, '')));
  const kept: ReviewIssue[] = [];
  let dropped = 0;
  for (const i of raw.issues ?? []) {
    const evidence = norm(i.evidence ?? '');
    const grounded = evidence.length >= 3 && diffLines.some((l) => l.includes(evidence) || (l.length >= 6 && evidence.includes(l)));
    if (!i.problem || i.severity === 'low' || !grounded) {
      dropped++;
      continue;
    }
    kept.push({ file: i.file ?? '', severity: i.severity ?? 'medium', problem: i.problem, evidence });
  }
  return { verdict: kept.length ? 'issues' : 'ok', issues: kept, dropped };
}

export function reviewFeedback(issues: ReviewIssue[]): string {
  const list = issues.map((i, n) => `${n + 1}. ${i.file ? `[${i.file}] ` : ''}${i.problem} (line: \`${i.evidence}\`)`).join('\n');
  return `A review of your changes found problems:\n${list}\nFix them with minimal edits. Do not rewrite unrelated code.`;
}
