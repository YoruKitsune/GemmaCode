export type SpecType =
  | 'none'
  | 'ngram-simple'
  | 'ngram-map-k'
  | 'ngram-mod'
  | 'ngram-cache'
  | 'draft-mtp';

/**
 * Режим по умолчанию для своего llama-server. ngram-simple берёт черновик из уже встреченного текста (промпт, прочитанные файлы,
 * собственный вывод), поэтому ускоряет правки файлов; на свободном тексте черновиков нет и скорость та же. Без отдельной
 * draft-модели, так что память не растёт. Обоснование и замеры: docs/M4.md.
 */
export const DEFAULT_SPECULATIVE: SpecType = 'ngram-simple';

/** Длина искомого n-грамма (N) и длина черновика (M) для ngram-simple и ngram-map-k. */
export const NGRAM_N = 12;
export const NGRAM_M = 48;

export interface ServerConfig {
  binary: string;
  port: number;
  /** Файл в Hugging Face в виде `user/repo[:quant]` либо путь к локальному GGUF. */
  model: { hf: string } | { file: string; mmproj?: string };
  /** false выключает проектор мультимодальности и экономит память. */
  multimodal: boolean;
  contextSize: number;
  kvCacheType: 'f16' | 'q8_0' | 'q4_0';
  reasoning: 'on' | 'off';
  speculative: SpecType;
  /** Размеры n-грамма для ngram-simple и ngram-map-k; по умолчанию NGRAM_N и NGRAM_M. */
  ngram?: { n?: number; m?: number };
  /** Каталог для file:// вложений. */
  mediaPath?: string;
  extraArgs?: string[];
}

/** Флаги проверены по tools/server/README.md llama.cpp (2026-10-20). */
export function buildServerArgs(c: ServerConfig): string[] {
  const args: string[] = [];
  if ('hf' in c.model) args.push('-hf', c.model.hf);
  else {
    args.push('-m', c.model.file);
    if (c.model.mmproj && c.multimodal) args.push('--mmproj', c.model.mmproj);
  }
  if (!c.multimodal) args.push('--no-mmproj');
  args.push('--host', '127.0.0.1', '--port', String(c.port));
  args.push('-c', String(c.contextSize), '-np', '1');
  args.push('-fa', 'on', '-ctk', c.kvCacheType, '-ctv', c.kvCacheType);
  args.push('--jinja', '--reasoning', c.reasoning);
  args.push('--no-webui');
  if (c.speculative !== 'none') args.push('--spec-type', c.speculative, ...ngramArgs(c));
  if (c.mediaPath) args.push('--media-path', c.mediaPath);
  if (c.extraArgs) args.push(...c.extraArgs);
  return args;
}

/** Имена флагов проверены по `llama-server --help` (build 11669): у каждого режима свои `--spec-ngram-<режим>-size-n/m`. */
function ngramArgs(c: ServerConfig): string[] {
  if (c.speculative !== 'ngram-simple' && c.speculative !== 'ngram-map-k') return [];
  const n = c.ngram?.n ?? NGRAM_N;
  const m = c.ngram?.m ?? NGRAM_M;
  return [`--spec-${c.speculative}-size-n`, String(n), `--spec-${c.speculative}-size-m`, String(m)];
}
