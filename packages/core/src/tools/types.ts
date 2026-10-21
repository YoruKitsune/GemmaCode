import type { SnapshotStore } from '../snapshot/store.ts';
import type { SkillCatalog } from '../skills/catalog.ts';
import type { SandboxRunner } from '../sandbox/index.ts';

/** Класс риска определяет, какие права нужны инструменту (см. permissions/policy.ts). */
export type ToolRisk = 'read' | 'write' | 'exec' | 'host' | 'external' | 'meta';

export interface ToolContext {
  /** Корень проекта: всё, что внутри него, считается «своим». */
  cwd: string;
  sessionId: string;
  signal?: AbortSignal;
  snapshots?: SnapshotStore;
  skills?: SkillCatalog;
  sandbox?: SandboxRunner;
  /** Состояние todo-списка сессии. */
  todos: string[];
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Результат содержит данные извне (веб, MCP, чужие скиллы): после него записи и команды требуют подтверждения. */
  untrusted?: boolean;
  /** Файлы, изменённые вызовом, для ленты действий и отметок в файловом менеджере. */
  touched?: string[];
}

/** Что вызов собирается сделать: по этому описанию политика прав принимает решение до выполнения. */
export interface ToolIntent {
  summary: string;
  /** Абсолютные пути, которых касается вызов. */
  paths?: string[];
  command?: string;
}

export interface ToolPreview {
  /** Абсолютный путь. */
  path: string;
  before: string | null;
  after: string;
}

export interface Tool<A = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema объекта аргументов. */
  parameters: JsonSchemaObject;
  risk: ToolRisk;
  inspect(args: A, ctx: ToolContext): ToolIntent;
  /** Что будет записано, без записи: для показа diff в запросе подтверждения. Не обязателен. */
  preview?(args: A, ctx: ToolContext): ToolPreview | null;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProp {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | (string & {});
  description?: string;
  enum?: string[];
  items?: { type: string };
}
