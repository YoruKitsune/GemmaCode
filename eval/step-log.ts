import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Подмножество событий агента, которое нужно журналу (события ядра и окна устроены одинаково). */
export interface LoggedEvent {
  type: string;
  name?: string;
  ms?: number;
  reason?: string;
  timings?: {
    promptTokens: number;
    cachedTokens: number;
    promptTokensPerSecond: number;
    predictedTokens: number;
    predictedTokensPerSecond: number;
    draftTokens?: number;
    draftAccepted?: number;
  };
}

export interface StepRecord {
  kind: 'step';
  mode: string;
  turn: string;
  step: number;
  /** Новые токены промпта (prompt_n), токены из кэша (cache_n), выданные токены (predicted_n). */
  promptN: number;
  cacheN: number;
  predictedN: number;
  predictedTps: number;
  /** Секунды генерации по данным сервера: predictedN / predictedTps. */
  genSec: number;
  promptTps: number;
  draftN: number | null;
  draftAccepted: number | null;
  /** Время шага по часам клиента от конца прошлого шага или инструмента до конца ответа, мс. */
  wallMs: number;
  tools: string[];
  /** Шаг закончился вызовом edit_file/write_file. */
  writes: boolean;
}

export interface TurnRecordLog {
  kind: 'turn';
  mode: string;
  turn: string;
  steps: number;
  wallMs: number;
  done: string;
}

/** Построчный журнал шагов (JSONL): timings сервера на каждый шаг цикла и вызовы инструментов, которыми шаг закончился. */
export class StepLog {
  private turn = '';
  private step = 0;
  private t0 = 0;
  private last = 0;
  private cur: StepRecord | undefined;

  readonly file: string;
  readonly mode: string;

  constructor(file: string, mode: string) {
    this.file = file;
    this.mode = mode;
    mkdirSync(dirname(file), { recursive: true });
  }

  private write(r: StepRecord | TurnRecordLog): void {
    appendFileSync(this.file, JSON.stringify(r) + '\n');
  }

  startTurn(id: string): void {
    this.flush();
    this.turn = id;
    this.step = 0;
    this.t0 = this.last = Date.now();
  }

  event(e: LoggedEvent): void {
    const now = Date.now();
    if (e.type === 'timings' && e.timings) {
      this.flush();
      const t = e.timings;
      this.step++;
      this.cur = {
        kind: 'step',
        mode: this.mode,
        turn: this.turn,
        step: this.step,
        promptN: t.promptTokens,
        cacheN: t.cachedTokens,
        predictedN: t.predictedTokens,
        predictedTps: t.predictedTokensPerSecond,
        genSec: t.predictedTokensPerSecond > 0 ? t.predictedTokens / t.predictedTokensPerSecond : 0,
        promptTps: t.promptTokensPerSecond,
        draftN: t.draftTokens ?? null,
        draftAccepted: t.draftAccepted ?? null,
        wallMs: now - this.last,
        tools: [],
        writes: false,
      };
      this.last = now;
    } else if (e.type === 'tool_call' && e.name && this.cur) {
      this.cur.tools.push(e.name);
      if (e.name === 'edit_file' || e.name === 'write_file') this.cur.writes = true;
    } else if (e.type === 'tool_result') {
      this.last = now;
    }
  }

  private flush(): void {
    if (this.cur) this.write(this.cur);
    this.cur = undefined;
  }

  endTurn(done: string): void {
    this.flush();
    this.write({ kind: 'turn', mode: this.mode, turn: this.turn, steps: this.step, wallMs: Date.now() - this.t0, done });
  }
}
