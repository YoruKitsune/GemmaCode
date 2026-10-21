// Проверка M3 с настоящей моделью: поднимает llama-server через сервис (как приложение), гоняет два сценария несколько раз
// и печатает таблицу. Запуск: node --experimental-strip-types scripts/m3-real.ts [--runs 3] [--model файл.gguf] [--mmproj файл.gguf]
// Браузер: Chrome/Chromium ищется сам, путь можно задать через CHROME_PATH.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../../../packages/host/src/host.ts';
import { scanModels } from '../../../packages/host/src/config-store.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runs = Number(arg('runs') ?? 3);
const out = arg('out') ?? join(tmpdir(), 'm3-real');
mkdirSync(out, { recursive: true });

const serverUrl = arg('server'); // готовый OpenAI-совместимый сервер вместо запуска llama-server (для отладки скрипта)
let modelFile = arg('model');
let mmproj = arg('mmproj');
if (!modelFile && !serverUrl) {
  const found = scanModels(homedir()).filter((m) => /E2B/i.test(m.file) && m.quant === 'Q4_K_M');
  const m = found.find((x) => x.mmproj) ?? found[0];
  if (!m) throw new Error('Не нашёл Gemma 4 E2B Q4_K_M: укажите --model');
  modelFile = m.file;
  mmproj ??= m.mmproj;
}
console.log(`Модель: ${serverUrl ?? modelFile}\nmmproj: ${mmproj ?? 'нет'}\nПрогонов на сценарий: ${runs}`);

const home = mkdtempSync(join(tmpdir(), 'gc-m3-home-'));
const host = new AgentHost({ home, version: 'm3-real', platform: { trash: async () => undefined } });
const events: { name: string; data: any }[] = [];
host.onEvent((name, data) => events.push({ name, data }));
host.onEvent((name, data) => {
  if (name === 'approval.request') void host.call('approval.answer', { id: data.id, answer: 'allow' });
});
await host.call('settings.set', { server: serverUrl ? { url: serverUrl } : { modelFile, ...(mmproj ? { mmproj } : {}) }, contextSize: 16384 });

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Greeting page</title>
<style>body{font:18px sans-serif;padding:24px}</style></head>
<body><h1 id="msg">Hello, wolrd!</h1><button onclick="console.log('clicked')">Click me</button>
<script>console.error('Greeting has a typo');</script></body></html>
`;

interface Scenario {
  name: string;
  prompt: string;
  files: Record<string, string>;
  passed: (dir: string, tools: string[]) => string | null;
}

const only = (arg('only') ?? 'ABC').toUpperCase();
const scenarios: Scenario[] = [
  {
    name: 'A. «Исправь sum» (точная фраза из M2)',
    prompt: 'Исправь функцию sum в utils.js: она должна складывать',
    files: { 'utils.js': 'export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n' },
    passed: (dir) => (/a \+ b/.test(readFileSync(join(dir, 'utils.js'), 'utf8')) ? null : 'sum не исправлена'),
  },
  {
    name: 'B. Гейт: «открой страницу, проверь, исправь»',
    prompt: 'Открой страницу site/index.html в браузере, проверь её и исправь, если что-то не так',
    files: { 'site/index.html': PAGE },
    passed: (dir, tools) => {
      if (!tools.includes('browser')) return 'браузер не открыт';
      return readFileSync(join(dir, 'site/index.html'), 'utf8').includes('Hello, world!') ? null : 'опечатка не исправлена';
    },
  },
  {
    name: 'C. Явная просьба про опечатку',
    prompt: 'Открой site/index.html в браузере, посмотри приветствие и исправь опечатку',
    files: { 'site/index.html': PAGE },
    passed: (dir, tools) => {
      if (!tools.includes('browser')) return 'браузер не открыт';
      return readFileSync(join(dir, 'site/index.html'), 'utf8').includes('Hello, world!') ? null : 'опечатка не исправлена';
    },
  },
];

const rows: string[] = [];
const detail: unknown[] = [];
const speed: { tps: number; ttft: number; rss: number | null; tools: number; errs: number }[] = [];
for (const sc of scenarios.filter((x) => only.includes(x.name[0]!))) {
  let ok = 0;
  for (let i = 1; i <= runs; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'gc-m3-proj-'));
    for (const [rel, text] of Object.entries(sc.files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    events.length = 0;
    await host.call('project.open', { path: dir });
    const s = await host.call('session.create', {});
    await host.call('session.options', { id: s.id, mode: 'auto-edit' });
    const t0 = Date.now();
    await host.call('chat.send', { sessionId: s.id, text: sc.prompt, attachments: [] });
    let timedOut = false;
    while (!events.some((e) => e.name === 'turn.end')) {
      if (Date.now() - t0 > 240_000) {
        timedOut = true;
        await host.call('chat.abort', { sessionId: s.id }).catch(() => undefined);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const tools = events.filter((e) => e.name === 'turn.event' && e.data.event.type === 'tool_call').map((e) => e.data.event.name as string);
    const nudges = events.filter((e) => e.name === 'turn.event' && e.data.event.type === 'nudge').length;
    const errors = events.filter((e) => e.name === 'turn.event' && e.data.event.type === 'tool_result' && e.data.event.isError).length;
    const approvals = events.filter((e) => e.name === 'approval.request').length;
    const st = (await host.call('stats.get', {})).agent;
    const last = st.recent.at(-1);
    if (last) speed.push({ tps: last.genTps, ttft: last.ttftMs, rss: st.modelRssMB, tools: st.toolCalls, errs: st.toolErrors });
    const ev = (t: string) => events.filter((e) => e.name === 'turn.event' && e.data.event.type === t).map((e) => e.data.event);
    const done = ev('done').map((d: any) => `${d.reason}${d.message ? ': ' + d.message : ''}`).join('; ');
    const backend = events.filter((e) => e.name === 'backend.status').map((e) => `${e.data.status}${e.data.message ? ' ' + e.data.message : ''}`).join(' | ');
    const text = ev('text').map((e: any) => e.delta).join('').slice(0, 300);
    console.log(`     done=${done || '-'}; backend=${backend || '-'}; text=${JSON.stringify(text)}`);
    for (const r of ev('tool_result') as any[]) console.log(`     ${r.name}${r.isError ? '!' : ''}: ${String(r.content).slice(0, 160)}`);
    for (const t of ['invalid_call', 'fallback']) for (const x of ev(t) as any[]) console.log(`     ${t}: ${JSON.stringify(x).slice(0, 700)}`);
        const fail = timedOut ? 'таймаут 240 с' : sc.passed(dir, tools);
    if (!fail) ok++;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const line = `${i}: ${fail ? '✗ ' + fail : '✓'}; ${secs} с; инструменты: ${tools.join(' → ') || 'нет'}; nudge ${nudges}, ошибок инструментов ${errors}, подтверждений ${approvals}`;
    console.log(`  ${sc.name} ${line}`);
    detail.push({ scenario: sc.name, run: i, fail, tools, nudges, errors, approvals, secs: Number(secs) });
    if (fail) cpSync(dir, join(out, `fail-${scenarios.indexOf(sc)}-${i}`), { recursive: true });
  }
  rows.push(`| ${sc.name} | ${ok} из ${runs} |`);
}

const avg = (f: (x: (typeof speed)[number]) => number): number => (speed.length ? speed.reduce((n, x) => n + f(x), 0) / speed.length : 0);
const a = { avgGenTps: avg((x) => x.tps), avgTtftMs: avg((x) => x.ttft), modelRssMB: speed.at(-1)?.rss ?? null, toolCalls: avg((x) => x.tools) * speed.length, toolSuccess: 0 };
const allTools = (detail as { tools: string[]; errors: number }[]).reduce((n, d) => n + d.tools.length, 0);
const allErrs = (detail as { errors: number }[]).reduce((n, d) => n + d.errors, 0);
a.toolCalls = allTools;
a.toolSuccess = allTools ? 1 - allErrs / allTools : 0;
const summary = [
  '| Сценарий | Успешно |',
  '|---|---|',
  ...rows,
  '',
  `Средне по ходам: ${a.avgGenTps.toFixed(1)} ток/с, до первого токена ${(a.avgTtftMs / 1000).toFixed(1)} с, инструменты без ошибок ${Math.round(a.toolSuccess * 100)}% (${a.toolCalls} вызовов), память модели ${a.modelRssMB ?? '—'} МБ`,
].join('\n');
console.log(`\n${summary}`);
writeFileSync(join(out, 'm3-real.md'), summary + '\n');
writeFileSync(join(out, 'm3-real.json'), JSON.stringify({ model: serverUrl ?? modelFile, runs, detail, speed, summary: a }, null, 2));
console.log(`\nРезультаты: ${out}`);
await host.shutdown();
process.exit(0);
