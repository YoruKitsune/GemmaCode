import type { Timings } from '../inference/backend.ts';

export type ApprovalAnswer = 'allow' | 'allow-session' | 'deny';

export interface ApprovalRequest {
  tool: string;
  summary: string;
  reason: string;
  /** Подробности для показа: например, фрагмент diff или полная команда. */
  detail?: string;
  /** Unified diff того, что изменит вызов (write_file, edit_file), до подтверждения. */
  diff?: string;
  grantLabel?: string;
}

export type DoneReason = 'completed' | 'max_steps' | 'aborted' | 'invalid_tool_calls' | 'loop_detected' | 'error';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'skill_loaded'; name: string; via: 'command' | 'match' }
  | { type: 'tool_call'; id: string; name: string; summary: string; args: Record<string, unknown> }
  | { type: 'approval'; id: string; answer: ApprovalAnswer | 'auto-denied'; reason: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean; touched: string[]; ms: number; diff?: string }
  | { type: 'fallback'; reason: string }
  | { type: 'invalid_call'; name: string; error: string; attempt: number }
  | { type: 'compaction'; stage: 'elide' | 'summary'; before: number; after: number }
  | { type: 'timings'; timings: Timings }
  | { type: 'done'; reason: DoneReason; steps: number; message?: string };

export interface SessionStats {
  steps: number;
  toolCalls: number;
  invalidCalls: number;
  promptTokens: number;
  generatedTokens: number;
  /** Средняя скорость генерации по шагам, ток/с. */
  genTokensPerSecond: number;
}
