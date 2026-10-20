import type { ChatChunk, ChatRequest, InferenceBackend } from '@gemmacode/core';
import type { EvalTask } from './types.ts';

/** «Идеальная модель»: пишет эталонное решение вызовами write_file. Проверяет конвейер оценки без настоящей модели. */
export class OracleBackend implements InferenceBackend {
  status = 'ready' as const;
  private readonly byPrompt: Map<string, EvalTask>;
  private served = new Map<string, number>();

  constructor(tasks: EvalTask[]) {
    this.byPrompt = new Map(tasks.map((t) => [t.prompt, t]));
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const firstUser = request.messages.find((m) => m.role === 'user');
    const task = this.byPrompt.get(typeof firstUser?.content === 'string' ? firstUser.content : '');
    const hasToolResult = request.messages.some((m) => m.role === 'tool');
    if (!task || hasToolResult) {
      yield { type: 'text', delta: 'Готово.' };
    } else {
      const entries = Object.entries(task.solution);
      let n = this.served.get(task.id) ?? 0;
      for (const [path, content] of entries) {
        if (content === null) continue;
        yield { type: 'toolCall', call: { id: `o${n++}`, name: 'write_file', arguments: JSON.stringify({ path, content }) } };
      }
      this.served.set(task.id, n);
    }
    yield { type: 'done', finishReason: 'stop' };
  }
}
