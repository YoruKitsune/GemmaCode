import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AttachedBackend, DEFAULT_SPECULATIVE, LlamaServerBackend, type InferenceBackend, type ServerConfig } from '@gemmacode/core';
import { renderReport, runEval } from './runner.ts';
import { StepLog } from './step-log.ts';
import { ALL_TASKS, SUITES } from './tasks/index.ts';
import type { Suite } from './types.ts';

const HELP = `Оценка агента GemmaCode на наборах задач.

  node --experimental-strip-types eval/run.ts [опции]

Движок (одно из):
  --server-url URL        подключиться к уже запущенному llama-server
  --model-file PATH       запустить llama-server с локальным GGUF (+ --mmproj PATH, --binary llama-server, --port 8811)

Набор и режимы:
  --suite edit30|gen20|all    (по умолчанию all)
  --only id1,id2              только эти задачи
  --limit N                   первые N задач
  --tool-mode native|schema   способ вызова инструментов (по умолчанию native)
  --loop                      повтор до зелёной проверки (видимые тесты либо проверка синтаксиса)
  --review                    само-ревью собственных правок
  --max-iterations N          попыток в режиме loop/review (по умолчанию 4)
  --max-steps N               шагов на одну попытку (по умолчанию 25)
  --spec none|ngram-simple|ngram-map-k   спекулятивный декодинг своего llama-server (по умолчанию как в приложении)
  --step-log FILE             журнал шагов JSONL: prompt_n, cache_n, predicted_n, draft_n, инструменты
  --context N                 размер контекста (по умолчанию 16384)
  --label NAME                метка прогона в имени отчёта
  --keep                      не удалять каталоги задач
`;

const { values: v } = parseArgs({
  options: {
    'server-url': { type: 'string' }, 'model-file': { type: 'string' }, mmproj: { type: 'string' }, binary: { type: 'string' }, port: { type: 'string' },
    suite: { type: 'string' }, only: { type: 'string' }, limit: { type: 'string' }, 'tool-mode': { type: 'string' }, loop: { type: 'boolean' }, review: { type: 'boolean' },
    'max-iterations': { type: 'string' }, 'max-steps': { type: 'string' }, context: { type: 'string' }, label: { type: 'string' }, spec: { type: 'string' }, 'step-log': { type: 'string' }, keep: { type: 'boolean' }, help: { type: 'boolean' },
  },
});
if (v.help || (!v['server-url'] && !v['model-file'])) {
  console.log(HELP);
  process.exit(v.help ? 0 : 2);
}

const contextSize = Number(v.context ?? 16384);
let backend: InferenceBackend;
if (v['server-url']) backend = new AttachedBackend(v['server-url']);
else {
  const cfg: ServerConfig = {
    binary: v.binary ?? 'llama-server',
    port: Number(v.port ?? 8811),
    model: { file: v['model-file']!, ...(v.mmproj ? { mmproj: v.mmproj } : {}) },
    multimodal: false,
    contextSize,
    kvCacheType: 'q8_0',
    reasoning: 'off',
    speculative: (v.spec ?? DEFAULT_SPECULATIVE) as ServerConfig['speculative'],
  };
  backend = new LlamaServerBackend(cfg);
}

const suite = (v.suite ?? 'all') as Suite | 'all';
let tasks = suite === 'all' ? ALL_TASKS : SUITES[suite];
if (!tasks) throw new Error(`Неизвестный набор: ${suite}`);
if (v.only) {
  const ids = new Set(v.only.split(','));
  tasks = ALL_TASKS.filter((t) => ids.has(t.id));
}
if (v.limit) tasks = tasks.slice(0, Number(v.limit));

const toolMode = (v['tool-mode'] ?? 'native') as 'native' | 'schema';
const config = { suite, tasks: tasks.length, toolMode, loop: !!v.loop, review: !!v.review, context: contextSize, maxSteps: Number(v['max-steps'] ?? 25) };
console.log(`Старт: ${JSON.stringify(config)}`);
await backend.start();
try {
  const { results, summary } = await runEval({
    backend,
    tasks,
    toolCallMode: toolMode,
    loop: !!v.loop,
    review: !!v.review,
    maxSteps: config.maxSteps,
    contextSize,
    ...(v['max-iterations'] ? { maxIterations: Number(v['max-iterations']) } : {}),
    ...(v.keep ? { keepDirs: true } : {}),
    ...(v['step-log'] ? { stepLog: new StepLog(v['step-log'], v.spec ?? (v['server-url'] ? 'external' : DEFAULT_SPECULATIVE)) } : {}),
    log: (l) => console.log(l),
  });
  const label = v.label ?? `${toolMode}${v.loop ? '-loop' : ''}${v.review ? '-review' : ''}`;
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = join(outDir, `${stamp}-${label}`);
  writeFileSync(`${base}.json`, JSON.stringify({ label, config, summary, results }, null, 1));
  const report = renderReport(label, config, results, summary);
  writeFileSync(`${base}.md`, report);
  console.log(`\n${report.split('\n').slice(0, 14).join('\n')}\n\nОтчёт: ${base}.md`);
} finally {
  await backend.stop();
}
