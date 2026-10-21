// Сколько стоит сжатие контекста: время дозаполнения (prefill) после того, как compactHistory переписал историю.
// Поднимает llama-server с флагами приложения, строит историю агента в ~10K токенов и меряет prompt_ms из timings сервера:
//   cold    — первый запрос, кэша нет
//   warm    — тот же префикс плюс один новый шаг (так идёт обычный ход)
//   elide   — старые результаты инструментов заменены заглушками (ступень 1 сжатия)
//   summary — старые шаги заменены сводкой, остаётся хвост из 8 сообщений (ступень 2)
// Запуск: node bench/compaction-cost.mjs --model-file ФАЙЛ.gguf --bin llama-server [--ctx 16384] [--out каталог]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withServer } from './lib/server.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const out = arg('out', join(process.cwd(), 'bench/results/compaction'));
mkdirSync(out, { recursive: true });
const ctx = Number(arg('ctx', '16384'));
const bin = arg('bin', 'llama-server');
const file = arg('model-file');
if (!file) throw new Error('Нужен --model-file');

const SYSTEM = 'You are GemmaCode, a local coding agent. '.repeat(8) + 'Use tools to read and edit files in the project. '.repeat(50);
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const code = (i, lines) => Array.from({ length: lines }, (_, j) => `export function f${i}_${j}(a: number, b: number): number { return a * ${j + i} + b - ${i * j}; } // helper ${i}.${j}`).join('\n');

/** История: системный промпт, задача и `steps` пар «вызов — результат». */
function history(steps, { elide = 0, summaryKeep = 0 } = {}) {
  const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Fix the bug in the project. Read the files first.' }];
  for (let i = 0; i < steps; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }] });
    const stub = i < elide;
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: stub ? `[output omitted to save context]: read_file src/f${i}.ts, 9000 chars` : code(i, 60) });
  }
  if (summaryKeep) {
    const head = msgs.slice(0, 2);
    const tail = msgs.slice(-summaryKeep);
    return [head[0], { role: 'user', content: `[Context was compacted. Summary of earlier work]\nFiles read: ${Array.from({ length: steps - summaryKeep / 2 }, (_, i) => `src/f${i}.ts`).join(', ')}.\nContinue the task.\n\nFix the bug in the project.` }, ...tail.slice(tail[0].role === 'assistant' ? 0 : 1)];
  }
  return msgs;
}

async function ask(baseUrl, messages, label) {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, tools, max_tokens: 4, temperature: 0, cache_prompt: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const t = j.timings ?? {};
  const row = { label, prompt_tokens: j.usage?.prompt_tokens, cached: t.cache_n, prefilled: t.prompt_n, prefill_s: +(t.prompt_ms / 1000).toFixed(2), prefill_tok_s: Math.round(t.prompt_per_second ?? 0), wall_s: +((performance.now() - t0) / 1000).toFixed(2) };
  console.log(JSON.stringify(row));
  return row;
}

const { value, meta } = await withServer(
  { bin, file, port: 8899, ctx, kv: 'q8_0', multimodal: false, thinking: false, spec: 'ngram-simple', extra: ['--spec-ngram-simple-size-n', '12', '--spec-ngram-simple-size-m', '48'], outDir: out, tag: 'compaction' },
  async ({ baseUrl }) => {
    const rows = [];
    const STEPS = 11;
    rows.push(await ask(baseUrl, history(STEPS), 'cold: история целиком'));
    rows.push(await ask(baseUrl, history(STEPS + 1), 'warm: +1 шаг (обычный ход)'));
    rows.push(await ask(baseUrl, history(STEPS + 1, { elide: 6 }), 'elide: 6 старых результатов заменены заглушками'));
    rows.push(await ask(baseUrl, history(STEPS + 2, { elide: 6 }), 'warm после elide: +1 шаг'));
    rows.push(await ask(baseUrl, history(STEPS + 2, { summaryKeep: 8 }), 'summary: сводка и хвост из 8 сообщений'));
    rows.push(await ask(baseUrl, history(STEPS + 3, { summaryKeep: 8 }), 'warm после summary: +1 шаг'));
    return rows;
  },
);
writeFileSync(join(out, 'compaction.json'), JSON.stringify({ ctx, file, meta, rows: value }, null, 2));
console.log(`\nГотово: ${join(out, 'compaction.json')}`);
