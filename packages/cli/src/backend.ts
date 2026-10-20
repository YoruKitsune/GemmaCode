import { AttachedBackend, LlamaServerBackend, type InferenceBackend, type ServerConfig, type ServerSettings } from '@gemmacode/core';

/** Движок по настройкам: готовый сервер по URL либо свой процесс llama-server. null — модель не настроена. */
export function createBackend(s: ServerSettings, contextSize: number): InferenceBackend | null {
  if (s.url) return new AttachedBackend(s.url);
  if (!s.modelFile && !s.hf) return null;
  const cfg: ServerConfig = {
    binary: s.binary ?? 'llama-server',
    port: s.port ?? 8811,
    model: s.hf ? { hf: s.hf } : { file: s.modelFile!, ...(s.mmproj ? { mmproj: s.mmproj } : {}) },
    multimodal: Boolean(s.mmproj),
    contextSize,
    kvCacheType: 'q8_0',
    reasoning: 'off',
    speculative: s.speculative ?? 'none',
  };
  return new LlamaServerBackend(cfg);
}

export const NO_MODEL_HELP =
  'Модель не настроена. Укажите --server-url http://127.0.0.1:8080 (запущенный llama-server) или --model-file путь.gguf ' +
  '(запустим llama-server сами), либо пропишите "server" в ~/.gemmacode/config.json. Автоматическая загрузка модели появится в M4.';
