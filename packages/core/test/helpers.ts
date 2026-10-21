import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatChunk, ChatRequest, InferenceBackend, ToolCall } from '../src/inference/backend.ts';

export function tempProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gemmacode-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

export type Scripted = { throws?: string; text?: string; calls?: { name: string; args: unknown }[]; timings?: { promptTokens: number; cachedTokens: number; predictedTokens: number } };

/** Движок с заранее заданными ответами: по одному на каждый вызов chat. Запросы сохраняются для проверок. */
export class ScriptedBackend implements InferenceBackend {
  status = 'ready' as const;
  requests: ChatRequest[] = [];
  private i = 0;
  private readonly script: (Scripted | ((req: ChatRequest) => Scripted))[];

  constructor(script: (Scripted | ((req: ChatRequest) => Scripted))[]) {
    this.script = script;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push(request);
    const entry = this.script[this.i++];
    if (!entry) throw new Error('script exhausted');
    const s = typeof entry === 'function' ? entry(request) : entry;
    if (s.throws) throw new Error(s.throws);
    if (request.jsonSchema) {
      // режим schema: весь ответ приходит JSON-текстом
      yield { type: 'text', delta: s.text ?? '' };
    } else {
      if (s.text) yield { type: 'text', delta: s.text };
      for (const [n, c] of (s.calls ?? []).entries()) {
        const call: ToolCall = { id: `c${this.i}_${n}`, name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) };
        yield { type: 'toolCall', call };
      }
    }
    yield {
      type: 'done',
      finishReason: 'stop',
      ...(s.timings ? { timings: { ...s.timings, promptTokensPerSecond: 100, predictedTokensPerSecond: 20 } } : {}),
    };
  }
}
