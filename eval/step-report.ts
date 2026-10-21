// Сводка по журналам шагов (eval/step-log.ts): node --experimental-strip-types eval/step-report.ts метка=файл.jsonl [метка=файл.jsonl ...]
import { readFileSync } from 'node:fs';
import type { StepRecord, TurnRecordLog } from './step-log.ts';

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export interface Summary {
  turns: number;
  steps: number;
  /** Эффективная скорость по ходам: токены хода / секунды генерации хода. */
  turnTpsMedian: number;
  turnTpsMean: number;
  /** То же по всем шагам сразу (взвешено временем). */
  pooledTps: number;
  /** Только шаги, закончившиеся edit_file/write_file. */
  writeSteps: number;
  writeTps: number;
  acceptRate: number | null;
  draftTokens: number;
  turnWallMedianS: number;
  turnWallMeanS: number;
  cacheHit: number;
  /** Доля кэша по номеру шага (1, 2, 3, 4+) и средние новые токены prompt_n. */
  cacheByStep: { step: string; n: number; hit: number; promptN: number }[];
}

export function summarizeLog(text: string): Summary {
  const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as StepRecord | TurnRecordLog);
  const steps = rows.filter((r): r is StepRecord => r.kind === 'step');
  const turns = rows.filter((r): r is TurnRecordLog => r.kind === 'turn');
  const byTurn = new Map<string, StepRecord[]>();
  for (const s of steps) byTurn.set(s.turn, [...(byTurn.get(s.turn) ?? []), s]);
  const tps = (xs: StepRecord[]): number => {
    const t = sum(xs.map((x) => x.genSec));
    return t > 0 ? sum(xs.map((x) => x.predictedN)) / t : 0;
  };
  const perTurn = [...byTurn.values()].map(tps).filter((x) => x > 0);
  const writes = steps.filter((s) => s.writes);
  const drafts = sum(steps.map((s) => s.draftN ?? 0));
  const hits = (xs: StepRecord[]): number => {
    const all = sum(xs.map((x) => x.promptN + x.cacheN));
    return all ? sum(xs.map((x) => x.cacheN)) / all : 0;
  };
  const buckets: [string, (n: number) => boolean][] = [['1', (n) => n === 1], ['2', (n) => n === 2], ['3', (n) => n === 3], ['4+', (n) => n >= 4]];
  return {
    turns: turns.length,
    steps: steps.length,
    turnTpsMedian: median(perTurn),
    turnTpsMean: mean(perTurn),
    pooledTps: tps(steps),
    writeSteps: writes.length,
    writeTps: tps(writes),
    acceptRate: drafts ? sum(steps.map((s) => s.draftAccepted ?? 0)) / drafts : null,
    draftTokens: drafts,
    turnWallMedianS: median(turns.map((t) => t.wallMs)) / 1000,
    turnWallMeanS: mean(turns.map((t) => t.wallMs)) / 1000,
    cacheHit: hits(steps),
    cacheByStep: buckets.map(([step, f]) => {
      const xs = steps.filter((s) => f(s.step));
      return { step, n: xs.length, hit: hits(xs), promptN: mean(xs.map((x) => x.promptN)) };
    }),
  };
}

if (process.argv[1]?.endsWith('step-report.ts')) {
  const f1 = (x: number) => x.toFixed(1);
  const rows = process.argv.slice(2).map((a) => {
    const [label, file] = a.split('=') as [string, string];
    return { label, s: summarizeLog(readFileSync(file, 'utf8')) };
  });
  console.log('| режим | ходов | шагов | ток/с по ходам (медиана / среднее) | ток/с общий | шагов с записью | ток/с на записи | принято | ход целиком, с (медиана / среднее) | кэш |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const { label, s } of rows) {
    console.log(`| ${label} | ${s.turns} | ${s.steps} | ${f1(s.turnTpsMedian)} / ${f1(s.turnTpsMean)} | ${f1(s.pooledTps)} | ${s.writeSteps} | ${s.writeSteps ? f1(s.writeTps) : '—'} | ${s.acceptRate === null ? '—' : `${Math.round(s.acceptRate * 100)}% из ${s.draftTokens}`} | ${f1(s.turnWallMedianS)} / ${f1(s.turnWallMeanS)} | ${Math.round(s.cacheHit * 100)}% |`);
  }
  console.log('\nДоля кэша по номеру шага в ходе (cache_n / весь промпт) и новые токены prompt_n в среднем:');
  console.log('| режим | ' + ['1', '2', '3', '4+'].map((b) => `шаг ${b}`).join(' | ') + ' |');
  console.log('|---|---|---|---|---|');
  for (const { label, s } of rows) console.log(`| ${label} | ${s.cacheByStep.map((c) => (c.n ? `${Math.round(c.hit * 100)}% (prompt_n ${Math.round(c.promptN)}, n=${c.n})` : '—')).join(' | ')} |`);
}
