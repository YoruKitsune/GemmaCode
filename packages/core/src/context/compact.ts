import type { ChatMessage, ToolCall } from '../inference/backend.ts';
import { estimateTokens, truncateMiddle } from './truncate.ts';

export function messageTokens(m: ChatMessage): number {
  if (m.role === 'user') {
    if (typeof m.content === 'string') return estimateTokens(m.content) + 6;
    return m.content.reduce((n, p) => n + (p.type === 'text' ? estimateTokens(p.text) : 300), 6);
  }
  if (m.role === 'assistant') {
    return estimateTokens(m.content) + (m.toolCalls ?? []).reduce((n, c) => n + estimateTokens(c.name + c.arguments) + 8, 6);
  }
  return estimateTokens(m.content) + 6;
}

export function totalTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0);
}

const ELIDED = '[output omitted to save context]';

/**
 * Первая ступень сжатия: тексты результатов инструментов старше последних `keepRecent` сообщений заменяются
 * короткой пометкой. Сами вызовы и ответы модели остаются, поэтому ход рассуждений читается.
 */
export function elideOldToolResults(messages: ChatMessage[], keepRecent: number): { messages: ChatMessage[]; changed: number } {
  const callById = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === 'assistant') for (const c of m.toolCalls ?? []) callById.set(c.id, c);
  let changed = 0;
  const cutoff = messages.length - keepRecent;
  const out = messages.map((m, i) => {
    if (i >= cutoff || m.role !== 'tool' || m.content.length < 400 || m.content.startsWith(ELIDED)) return m;
    const call = callById.get(m.toolCallId);
    changed++;
    return { ...m, content: `${ELIDED}: ${call ? describeCall(call) : 'tool result'}, ${m.content.length} chars` };
  });
  return { messages: out, changed };
}

export function describeCall(c: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(c.arguments) as Record<string, unknown>;
  } catch {
    // невалидные аргументы оставляем пустыми
  }
  const key = args.path ?? args.command ?? args.pattern ?? args.name ?? '';
  return `${c.name}${key ? ` ${truncateMiddle(String(key), 80)}` : ''}`;
}

/**
 * Вторая ступень: детерминированная сводка действий без участия модели. Модель на 8 ГБ дорога, а список
 * «что читали, что меняли, чем кончились команды» восстанавливается из истории точно.
 */
export function ruleBasedSummary(messages: readonly ChatMessage[]): string {
  const read = new Set<string>();
  const changed = new Set<string>();
  const log: string[] = [];
  const callById = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === 'assistant') for (const c of m.toolCalls ?? []) callById.set(c.id, c);
  for (const m of messages) {
    if (m.role === 'assistant' && m.content.trim() && !m.toolCalls?.length) log.push(`Assistant said: ${truncateMiddle(m.content.trim(), 160)}`);
    if (m.role !== 'tool') continue;
    const call = callById.get(m.toolCallId);
    if (!call) continue;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      continue;
    }
    const path = typeof args.path === 'string' ? args.path : '';
    const failed = /^(Invalid arguments|Denied|old_string|File not found|Failed)/.test(m.content);
    if (call.name === 'read_file' && path && !failed) read.add(path);
    else if ((call.name === 'edit_file' || call.name === 'write_file') && path && !failed) changed.add(path);
    else if (call.name === 'shell') {
      const code = /\[exit code (\d+)\]/.exec(m.content)?.[1];
      const tail = code && code !== '0' ? ` — ${truncateMiddle(m.content.split('\n').slice(-4).join(' | '), 200)}` : '';
      log.push(`Ran \`${truncateMiddle(String(args.command ?? ''), 100)}\` → exit ${code ?? '?'}${tail}`);
    }
  }
  const parts: string[] = [];
  if (changed.size) parts.push(`Files changed so far: ${[...changed].join(', ')}.`);
  if (read.size) parts.push(`Files read: ${[...read].slice(0, 20).join(', ')}.`);
  if (log.length) parts.push(`Notable steps:\n${log.slice(-12).map((l) => `- ${l}`).join('\n')}`);
  return parts.join('\n') || 'No notable actions yet.';
}

export interface CompactResult {
  messages: ChatMessage[];
  before: number;
  after: number;
  stage: 'none' | 'elide' | 'summary';
}

/**
 * Сжимает историю, если оценка превышает `target` токенов. Ступени: (1) заглушки вместо старых результатов,
 * (2) сводка старых шагов вместо самих шагов. Первое сообщение пользователя текущей задачи сохраняется дословно.
 */
export function compactHistory(messages: ChatMessage[], target: number, keepRecent = 8): CompactResult {
  const before = totalTokens(messages);
  if (before <= target) return { messages, before, after: before, stage: 'none' };
  const elided = elideOldToolResults(messages, keepRecent);
  let current = elided.messages;
  let after = totalTokens(current);
  if (after <= target) return { messages: current, before, after, stage: 'elide' };

  const lastUser = findLastUserIndex(current);
  const cut = findCutIndex(current, lastUser, keepRecent);
  if (cut <= 0) return { messages: current, before, after, stage: 'elide' };
  const old = current.slice(0, cut);
  const task = lastUser >= 0 && lastUser < cut ? current[lastUser] : undefined;
  const taskText = task && task.role === 'user' ? (typeof task.content === 'string' ? task.content : task.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join(' ')) : '';
  const summary: ChatMessage = {
    role: 'user',
    content:
      `[Context was compacted. Summary of earlier work in this session]\n` +
      (taskText ? `Current task: ${truncateMiddle(taskText, 1500)}\n` : '') +
      ruleBasedSummary(old) +
      `\nContinue the task from where it stands; re-read files if you need their exact content.`,
  };
  const tail = current.slice(cut);
  const head = tail[0];
  if (head && head.role === 'user' && typeof head.content === 'string') {
    current = [{ role: 'user', content: `${summary.content as string}\n\n${head.content}`, ...(head.checkpoint ? { checkpoint: head.checkpoint } : {}), ...(head.ui ? { ui: head.ui } : {}) }, ...tail.slice(1)];
  } else {
    current = [summary, ...tail];
  }
  after = totalTokens(current);
  return { messages: current, before, after, stage: 'summary' };
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return i;
  return -1;
}

/** Граница среза: сообщение `assistant`, чтобы пара «вызов — результат» не разорвалась и роли чередовались. */
function findCutIndex(messages: ChatMessage[], lastUser: number, keepRecent: number): number {
  let cut = Math.max(0, messages.length - keepRecent);
  while (cut < messages.length && messages[cut]!.role !== 'assistant') cut++;
  // Если последний ход пользователя целиком в хвосте, его текст остаётся; иначе он уйдёт в сводку дословно.
  if (lastUser >= cut) {
    cut = lastUser;
  }
  return cut >= messages.length ? 0 : cut;
}
