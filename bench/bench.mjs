#!/usr/bin/env node
// Стенд замеров M0. Только встроенные модули Node (>= 20), сборка не нужна.
// Подробности и порядок запуска: bench/README.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGguf } from './lib/models.mjs';
import { withServer } from './lib/server.mjs';
import { runScenarios } from './lib/speed.mjs';
import { runToolEval } from './lib/toolcalls.mjs';
import { makeFixtures, probeMedia } from './lib/media.mjs';
import { systemInfo } from './lib/system.mjs';
import { writeReport } from './lib/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'config', 'candidates.json'), 'utf8'));

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) o._.push(a);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) o[a.slice(2)] = true;
    else o[a.slice(2)] = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const list = (v, d) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

const cmd = args._[0];
const opts = {
  bin: args.bin ?? 'llama-server',
  out: resolve(args.out ?? join(here, 'results')),
  port: Number(args.port ?? 8801),
  ctx: Number(args.ctx ?? cfg.context),
  kv: args.kv ?? cfg.kvCache,
  repos: list(args.repo, cfg.repos),
  quants: list(args.quants, cfg.quants),
  specs: list(args.spec, ['none']),
  scenarios: list(args.scenarios, cfg.scenarios),
  runs: Number(args.runs ?? 3),
  modes: list(args.mode === 'both' ? 'native,schema' : args.mode, ['native']),
  limit: args.limit ? Number(args.limit) : undefined,
  thinking: Boolean(args.thinking),
};
mkdirSync(opts.out, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const save = (kind, tag, rec) => {
  const file = join(opts.out, `${kind}__${tag}__${stamp()}.json`);
  writeFileSync(file, JSON.stringify(rec, null, 1));
  console.log(`  → ${file}`);
};

async function serverFor(quant, spec, multimodal, fn) {
  const local = args['model-file'];
  const model = local ? { repo: null, file: basename(local), path: local, sizeBytes: null } : await resolveGguf(opts.repos, quant);
  console.log(`\n== ${quant}: ${model.repo ?? 'локальный файл'}/${model.file}${model.sizeBytes ? ` (${(model.sizeBytes / 2 ** 30).toFixed(2)} ГБ)` : ''}, spec=${spec}`);
  const tag = `${quant}-ctx${opts.ctx}-kv${opts.kv}-${spec}${multimodal ? '-mm' : ''}`;
  const { value, meta } = await withServer(
    { bin: opts.bin, ...(model.path ? { file: model.path } : { hfRepo: model.repo, hfFile: model.file }), port: opts.port, ctx: opts.ctx, kv: opts.kv, spec, multimodal, thinking: opts.thinking, outDir: opts.out, tag, extra: list(args['server-args'], []) },
    fn,
  );
  const modelMismatch = meta.modelPath ? basename(meta.modelPath) !== model.file : null;
  if (modelMismatch) console.log(`  !! сервер загрузил ${meta.modelPath}, а не ${model.file}: результаты не считать`);
  return { value, meta: { ...meta, modelMismatch }, model, tag };
}

async function cmdSpeed() {
  if (args.endpoint) {
    // Внешний сервер (MLX, Ollama и т.п.): только замеры, без управления процессом.
    const label = args.label ?? 'external';
    console.log(`\n== внешний эндпоинт ${args.endpoint} (${label})`);
    const res = await runScenarios(args.endpoint, opts.scenarios, { runs: opts.runs, model: args['model-name'] });
    save('speed', `ext-${label}`, { kind: 'speed', external: true, label, endpoint: args.endpoint, system: await systemInfo(opts.bin), scenarios: res });
    return;
  }
  const system = await systemInfo(opts.bin);
  for (const quant of opts.quants) {
    for (const spec of opts.specs) {
      try {
        const { value, meta, model, tag } = await serverFor(quant, spec, false, (c) => runScenarios(c.baseUrl, opts.scenarios, { runs: opts.runs }));
        save('speed', tag, { kind: 'speed', quant, spec, ctx: opts.ctx, kv: opts.kv, file: model.file, sizeBytes: model.sizeBytes, system, ...meta, scenarios: value });
      } catch (e) {
        console.log(`  ✗ ${quant}/${spec}: ${e.message}`);
        save('speed', `${quant}-${spec}-FAILED`, { kind: 'speed', quant, spec, error: e.message });
      }
    }
  }
}

async function cmdTools() {
  for (const quant of opts.quants) {
    try {
      const { value, meta, model, tag } = await serverFor(quant, 'none', false, async (c) => {
        const out = {};
        for (const mode of opts.modes) {
          console.log(`  режим ${mode}:`);
          out[mode] = await runToolEval(c.baseUrl, { mode, limit: opts.limit });
          console.log(`  ${mode}: ${out[mode].ok}/${out[mode].n} (${(out[mode].rate * 100).toFixed(0)}%)`, out[mode].reasons);
        }
        return out;
      });
      save('tools', tag, { kind: 'tools', quant, file: model.file, sizeBytes: model.sizeBytes, thinking: opts.thinking, ...meta, results: value });
    } catch (e) {
      console.log(`  ✗ ${quant}: ${e.message}`);
      save('tools', `${quant}-FAILED`, { kind: 'tools', quant, error: e.message });
    }
  }
}

async function cmdMedia() {
  const quant = args.quant ?? 'Q4_K_M';
  const files = await makeFixtures(join(opts.out, 'media'), { audioPath: args.audio, videoPath: args.video });
  console.log('фикстуры:', files);
  const { value, meta, model, tag } = await serverFor(quant, 'none', true, (c) => probeMedia(c.baseUrl, files).then((r) => ({ results: r, modalities: c.props.modalities ?? null })));
  save('media', tag, { kind: 'media', quant, file: model.file, ...meta, ...value });
}

const commands = {
  speed: cmdSpeed,
  tools: cmdTools,
  media: cmdMedia,
  report: async () => console.log(`отчёт: ${writeReport(opts.out, cfg)}`),
  info: async () => {
    console.log(JSON.stringify(await systemInfo(opts.bin), null, 2));
    for (const q of opts.quants) console.log(q, await resolveGguf(opts.repos, q).catch((e) => e.message));
  },
  all: async () => {
    await cmdSpeed();
    await cmdTools();
    await commands.report();
  },
};

if (!commands[cmd]) {
  console.log(`Использование: node bench/bench.mjs <info|speed|tools|media|report|all> [опции]
  --quants Q4_0,Q4_K_M   квантования (по умолчанию из config/candidates.json)
  --spec none,ngram-mod  варианты спекулятивного декодинга (speed)
  --scenarios chat,edit  сценарии скорости: chat, prefill2k, prefill8k, edit
  --mode native|schema|both   режим вызова инструментов (tools)
  --limit N              только первые N задач (tools)
  --ctx 16384 --kv q8_0  контекст и тип KV-кэша
  --thinking             включить режим рассуждения
  --repo a/b,c/d         репозитории HF с GGUF
  --model-file PATH      использовать локальный GGUF вместо загрузки (тогда указывайте один --quants)
  --bin PATH             путь к llama-server
  --endpoint URL --label NAME [--model-name ID]   замер внешнего сервера (MLX и др.)
  --quant Q4_K_M --audio FILE --video FILE        проба мультимодальности (media)`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
