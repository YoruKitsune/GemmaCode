export type SpecType =
  | 'none'
  | 'ngram-simple'
  | 'ngram-map-k'
  | 'ngram-mod'
  | 'ngram-cache'
  | 'draft-mtp';

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
  if (c.speculative !== 'none') args.push('--spec-type', c.speculative);
  if (c.mediaPath) args.push('--media-path', c.mediaPath);
  if (c.extraArgs) args.push(...c.extraArgs);
  return args;
}
