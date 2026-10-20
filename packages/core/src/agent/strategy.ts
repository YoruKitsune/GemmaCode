import type { ChatChunk, ChatMessage, ChatRequest, ToolCall, ToolDefinition } from '../inference/backend.ts';

/** Как модель вызывает инструменты: родным механизмом (tools + --jinja) или ответом по JSON-схеме. */
export type ToolCallMode = 'native' | 'schema';

export interface Turn {
  text: string;
  calls: ToolCall[];
  /** Ответ в режиме schema не разобрался как JSON. */
  malformed?: boolean;
}

export interface Strategy {
  readonly mode: ToolCallMode;
  /** Запрос к движку. `system` и история хранятся в каноническом виде, здесь они преобразуются под режим. */
  request(system: string, history: ChatMessage[], tools: ToolDefinition[], limits: { maxTokens: number; temperature: number }): ChatRequest;
  /** Нужно ли показывать текстовые дельты пользователю сразу (в режиме schema поток — это сырой JSON). */
  readonly streamsText: boolean;
  finish(text: string, calls: ToolCall[]): Turn;
}

export class NativeStrategy implements Strategy {
  readonly mode = 'native' as const;
  readonly streamsText = true;
  request(system: string, history: ChatMessage[], tools: ToolDefinition[], limits: { maxTokens: number; temperature: number }): ChatRequest {
    return { messages: [{ role: 'system', content: system }, ...history], tools, maxTokens: limits.maxTokens, temperature: limits.temperature };
  }
  finish(text: string, calls: ToolCall[]): Turn {
    return { text, calls };
  }
}

const REPLY = 'reply';

/**
 * Режим schema: ответ модели ограничен JSON-схемой {"tool": имя, "arguments": {...}}, поэтому невалидный вызов
 * невозможен. Цена: инструменты описываются в тексте промпта, а история хранится текстом.
 */
export class SchemaStrategy implements Strategy {
  readonly mode = 'schema' as const;
  readonly streamsText = false;

  request(system: string, history: ChatMessage[], tools: ToolDefinition[], limits: { maxTokens: number; temperature: number }): ChatRequest {
    const listing = tools.map((t) => `- ${t.name}: ${t.description} Arguments: ${JSON.stringify((t.parameters as { properties?: unknown }).properties ?? {})}`).join('\n');
    const prompt =
      `${system}\n\nRespond with exactly one JSON object {"tool": <name>, "arguments": {...}}. Available tools:\n${listing}\n` +
      `- ${REPLY}: finish and answer the user directly. Arguments: {"text": string}`;
    return {
      messages: [{ role: 'system', content: prompt }, ...history.map(flatten)],
      jsonSchema: schemaFor(tools),
      maxTokens: limits.maxTokens,
      temperature: limits.temperature,
    };
  }

  finish(text: string): Turn {
    try {
      const o = JSON.parse(text) as { tool?: string; arguments?: Record<string, unknown> };
      if (o.tool === REPLY) return { text: String(o.arguments?.text ?? ''), calls: [] };
      if (typeof o.tool === 'string') {
        return { text: '', calls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, name: o.tool, arguments: JSON.stringify(o.arguments ?? {}) }] };
      }
    } catch {
      // ниже: сообщаем, что разобрать не удалось
    }
    return { text, calls: [], malformed: true };
  }
}

export function schemaFor(tools: ToolDefinition[]): Record<string, unknown> {
  const variants = tools.map((t) => ({
    type: 'object',
    properties: { tool: { const: t.name }, arguments: t.parameters },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  }));
  variants.push({
    type: 'object',
    properties: {
      tool: { const: REPLY },
      arguments: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  } as never);
  return { anyOf: variants };
}

function flatten(m: ChatMessage): ChatMessage {
  if (m.role === 'assistant') {
    if (m.toolCalls?.length) {
      const c = m.toolCalls[0]!;
      let args: unknown = {};
      try {
        args = JSON.parse(c.arguments);
      } catch {
        // оставляем пустые аргументы
      }
      return { role: 'assistant', content: JSON.stringify({ tool: c.name, arguments: args }) };
    }
    return { role: 'assistant', content: JSON.stringify({ tool: REPLY, arguments: { text: m.content } }) };
  }
  if (m.role === 'tool') return { role: 'user', content: `Tool result:\n${m.content}` };
  return m;
}

export type { ChatChunk };
