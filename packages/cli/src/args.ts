import { parseArgs } from 'node:util';
import type { PermissionMode, SkillRouting, ToolCallMode, Toolset } from '@gemmacode/core';

export interface CliOptions {
  prompt: string;
  print: boolean;
  json: boolean;
  cwd: string;
  mode?: PermissionMode;
  toolset?: Toolset;
  toolCallMode?: ToolCallMode;
  skillRouting?: SkillRouting;
  verify?: string;
  review?: boolean;
  maxIterations?: number;
  contextSize?: number;
  resume?: string | true;
  server: { url?: string; binary?: string; modelFile?: string; mmproj?: string; hf?: string; port?: number };
  help: boolean;
}

export const HELP = `GemmaCode — локальный агент на Gemma 4

Использование:
  gemmacode [опции] [задача]       интерактивный режим; с задачей — выполнить её и остаться в диалоге
  gemmacode -p "задача" [опции]    выполнить задачу и выйти (код выхода 0 — успех)

Модель (одно из):
  --server-url URL         подключиться к уже запущенному llama-server
  --model-file PATH        запустить llama-server с локальным GGUF (--mmproj PATH, --binary, --port)
  --hf REPO[:QUANT]        запустить llama-server и скачать модель из Hugging Face

Права и инструменты:
  --mode read-only|ask|auto-edit|full   режим прав (по умолчанию ask); --yolo = full
  --toolset read|edit|full              набор инструментов в промпте (по умолчанию edit)
  --tool-mode native|schema             способ вызова инструментов (schema — ответ по JSON-схеме)
  --skills model|explicit|auto          как подключать скиллы (по умолчанию auto)

Надёжность:
  --verify "команда"|auto  режим loop: после хода запустить проверку и чинить, пока она не пройдёт
  --review                 само-ревью собственных правок
  --max-iterations N       попыток в режиме loop/review (по умолчанию 4)

Прочее:
  --cwd PATH               каталог проекта (по умолчанию текущий)
  --context N              размер контекста (по умолчанию 16384)
  --resume [ID]            продолжить сессию (последнюю или по номеру)
  --json                   с -p: события построчно в JSON
  -h, --help

В диалоге: /help показывает слэш-команды. Конфиг: ~/.gemmacode/config.json и .gemmacode/config.json в проекте.`;

export function parseCli(argv: string[]): CliOptions {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p' }, json: { type: 'boolean' }, cwd: { type: 'string' },
      mode: { type: 'string' }, yolo: { type: 'boolean' }, toolset: { type: 'string' }, 'tool-mode': { type: 'string' }, skills: { type: 'string' },
      verify: { type: 'string' }, review: { type: 'boolean' }, 'max-iterations': { type: 'string' }, context: { type: 'string' },
      resume: { type: 'string' }, 'server-url': { type: 'string' }, 'model-file': { type: 'string' }, mmproj: { type: 'string' },
      hf: { type: 'string' }, binary: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const oneOf = <T extends string>(name: string, val: string | undefined, allowed: readonly T[]): T | undefined => {
    if (val === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(val)) throw new Error(`--${name}: допустимо ${allowed.join(', ')}`);
    return val as T;
  };
  const num = (name: string, val: string | undefined): number | undefined => {
    if (val === undefined) return undefined;
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name}: нужно положительное число`);
    return n;
  };
  const mode = v.yolo ? 'full' : oneOf<PermissionMode>('mode', v.mode, ['read-only', 'ask', 'auto-edit', 'full']);
  const server: CliOptions['server'] = {};
  if (v['server-url']) server.url = v['server-url'];
  if (v['model-file']) server.modelFile = v['model-file'];
  if (v.mmproj) server.mmproj = v.mmproj;
  if (v.hf) server.hf = v.hf;
  if (v.binary) server.binary = v.binary;
  if (v.port) server.port = num('port', v.port)!;
  return {
    prompt: positionals.join(' ').trim(),
    print: v.print === true,
    json: v.json === true,
    cwd: v.cwd ?? process.cwd(),
    ...(mode ? { mode } : {}),
    ...(oneOf<Toolset>('toolset', v.toolset, ['read', 'edit', 'full']) ? { toolset: oneOf<Toolset>('toolset', v.toolset, ['read', 'edit', 'full'])! } : {}),
    ...(oneOf<ToolCallMode>('tool-mode', v['tool-mode'], ['native', 'schema']) ? { toolCallMode: oneOf<ToolCallMode>('tool-mode', v['tool-mode'], ['native', 'schema'])! } : {}),
    ...(oneOf<SkillRouting>('skills', v.skills, ['model', 'explicit', 'auto']) ? { skillRouting: oneOf<SkillRouting>('skills', v.skills, ['model', 'explicit', 'auto'])! } : {}),
    ...(v.verify !== undefined ? { verify: v.verify } : {}),
    ...(v.review ? { review: true } : {}),
    ...(num('max-iterations', v['max-iterations']) ? { maxIterations: num('max-iterations', v['max-iterations'])! } : {}),
    ...(num('context', v.context) ? { contextSize: num('context', v.context)! } : {}),
    ...(v.resume !== undefined ? { resume: v.resume === '' ? true : v.resume } : {}),
    server,
    help: v.help === true,
  };
}
