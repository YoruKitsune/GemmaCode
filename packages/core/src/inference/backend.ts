/** Всё, что ядро агента знает о движке инференса. Остальной код зависит только от этого файла. */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string }
  | { type: 'audio'; path: string }
  | { type: 'video'; path: string };

/** Что видит пользователь вместо служебного текста сообщения: его слова и вложения. Движок это поле не получает. */
export interface UserMessageUi {
  text: string;
  attachments: { name: string; kind: string; relPaths: string[]; note?: string }[];
}

export interface ToolCall {
  id: string;
  name: string;
  /** Аргументы как JSON-строка: модель может выдать невалидный JSON, проверяет ядро. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  /** `checkpoint` — номер контрольной точки откатов, открытой этим сообщением (см. snapshot/store.ts). */
  | { role: 'user'; content: string | ContentPart[]; checkpoint?: number; ui?: UserMessageUi }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema объекта аргументов. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** JSON Schema, которому обязан соответствовать ответ (llama.cpp превращает её в грамматику). */
  jsonSchema?: Record<string, unknown>;
}

export interface Timings {
  promptTokens: number;
  cachedTokens: number;
  promptTokensPerSecond: number;
  predictedTokens: number;
  predictedTokensPerSecond: number;
}

export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'done'; finishReason: string; timings?: Timings };

export type BackendStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface InferenceBackend {
  readonly status: BackendStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}
