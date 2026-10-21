import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { buildServerArgs, type ServerConfig } from './args.ts';
import type {
  BackendStatus,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ContentPart,
  InferenceBackend,
  Timings,
  ToolCall,
} from './backend.ts';

const HEALTH_TIMEOUT_MS = 120_000;

/** llama-server как дочерний процесс; общение по OpenAI-совместимому HTTP API. */
export class LlamaServerBackend implements InferenceBackend {
  status: BackendStatus = 'stopped';
  private proc?: ChildProcess;

  private readonly config: ServerConfig;

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  constructor(config: ServerConfig) {
    this.config = config;
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }

  async start(): Promise<void> {
    if (this.status === 'ready' || this.status === 'starting') return;
    this.status = 'starting';
    const proc = spawn(this.config.binary, buildServerArgs(this.config), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    // Дочерний процесс не должен пережить нас: при падении или закрытии окна он держал бы гигабайты памяти.
    const killWithParent = () => proc.kill('SIGKILL');
    process.once('exit', killWithParent);
    proc.once('exit', () => process.off('exit', killWithParent));
    let stderrTail = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    const exited = new Promise<never>((_, reject) => {
      proc.once('exit', (code) => {
        this.status = 'stopped';
        reject(new Error(`llama-server завершился с кодом ${code}\n${stderrTail}`));
      });
    });
    try {
      await Promise.race([this.waitHealthy(), exited]);
      this.status = 'ready';
    } catch (e) {
      this.status = 'error';
      proc.kill('SIGTERM');
      throw e;
    }
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.baseUrl}/health`);
        if (r.ok) return;
      } catch {
        // сервер ещё не слушает порт
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('llama-server не ответил на /health вовремя');
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) {
      this.status = 'stopped';
      return;
    }
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
    });
    this.status = 'stopped';
  }

  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    return streamChat(this.baseUrl, request, signal);
  }
}

/** Подключение к уже запущенному llama-server (или совместимому OpenAI-эндпоинту): процесс не создаётся. */
export class AttachedBackend implements InferenceBackend {
  status: BackendStatus = 'stopped';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async start(): Promise<void> {
    const r = await fetch(`${this.baseUrl}/health`).catch(() => undefined);
    if (!r?.ok) {
      this.status = 'error';
      throw new Error(`Сервер ${this.baseUrl} не отвечает на /health`);
    }
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    return streamChat(this.baseUrl, request, signal);
  }
}

export async function* streamChat(baseUrl: string, request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
  const body: Record<string, unknown> = {
    messages: await Promise.all(request.messages.map(toWireMessage)),
    stream: true,
    cache_prompt: true,
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens ?? 1024,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (request.jsonSchema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'out', schema: request.jsonSchema } };
  }
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw new Error(`llama-server: HTTP ${res.status} ${await res.text()}`);

  const pending = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason = 'stop';
  let timings: Timings | undefined;

  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') break;
    const evt = JSON.parse(data) as WireChunk;
    if (evt.timings) timings = toTimings(evt.timings);
    const choice = evt.choices?.[0];
    if (!choice) continue;
    const d = choice.delta;
    if (d?.content) yield { type: 'text', delta: d.content };
    if (d?.reasoning_content) yield { type: 'reasoning', delta: d.reasoning_content };
    for (const tc of d?.tool_calls ?? []) {
      const cur = pending.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      pending.set(tc.index, cur);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    const out: ToolCall = { id: call.id || `call_${index}`, name: call.name, arguments: call.arguments };
    yield { type: 'toolCall', call: out };
  }
  yield { type: 'done', finishReason, ...(timings ? { timings } : {}) };
}

interface WireChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  timings?: {
    prompt_n: number;
    cache_n: number;
    prompt_per_second: number;
    predicted_n: number;
    predicted_per_second: number;
  };
}

function toTimings(t: NonNullable<WireChunk['timings']>): Timings {
  return {
    promptTokens: t.prompt_n,
    cachedTokens: t.cache_n,
    promptTokensPerSecond: t.prompt_per_second,
    predictedTokens: t.predicted_n,
    predictedTokensPerSecond: t.predicted_per_second,
  };
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of event.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

async function toWirePart(p: ContentPart): Promise<unknown> {
  if (p.type === 'text') return { type: 'text', text: p.text };
  const ext = p.path.split('.').pop()?.toLowerCase() ?? '';
  const b64 = (await readFile(p.path)).toString('base64');
  if (p.type === 'image') return { type: 'image_url', image_url: { url: `data:${MIME[ext] ?? 'image/png'};base64,${b64}` } };
  if (p.type === 'audio') return { type: 'input_audio', input_audio: { data: b64, format: ext || 'wav' } };
  return { type: 'input_video', input_video: { data: b64 } };
}

async function toWireMessage(m: ChatMessage): Promise<unknown> {
  switch (m.role) {
    case 'user':
      return {
        role: 'user',
        content: typeof m.content === 'string' ? m.content : await Promise.all(m.content.map(toWirePart)),
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}
