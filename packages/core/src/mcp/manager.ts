import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { truncateMiddle } from '../context/truncate.ts';
import { cleanEnv } from '../tools/shell.ts';
import type { Tool, JsonSchemaObject, JsonSchemaProp } from '../tools/types.ts';

export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean }
  | { url: string; headers?: Record<string, string>; disabled?: boolean };

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'disabled';
  tools: string[];
  skipped: number;
  error?: string;
}

export interface McpOptions {
  cwd: string;
  /** Максимум инструментов от одного сервера: описания занимают контекст, а выбор из десятков путает маленькую модель. */
  maxToolsPerServer?: number;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxResultChars?: number;
}

interface Connected {
  name: string;
  client: Client;
  tools: Tool<any>[];
}

/** Подключает MCP-серверы (stdio и HTTP), превращая их инструменты в обычные инструменты ядра с риском `external`. */
export class McpManager {
  private readonly servers: Connected[] = [];
  private readonly infos: McpServerInfo[] = [];
  private readonly o: Required<McpOptions>;

  constructor(opts: McpOptions) {
    this.o = { maxToolsPerServer: 8, connectTimeoutMs: 20_000, callTimeoutMs: 60_000, maxResultChars: 8000, ...opts };
  }

  async connect(configs: Record<string, McpServerConfig>): Promise<McpServerInfo[]> {
    await Promise.all(Object.entries(configs).map(([name, cfg]) => this.connectOne(name, cfg)));
    return this.infos;
  }

  info(): readonly McpServerInfo[] {
    return this.infos;
  }

  tools(): Tool<any>[] {
    return this.servers.flatMap((s) => s.tools);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((s) => s.client.close()));
    this.servers.length = 0;
  }

  private async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
    if (cfg.disabled) {
      this.infos.push({ name, status: 'disabled', tools: [], skipped: 0 });
      return;
    }
    if (!/^[\w-]+$/.test(name)) {
      this.infos.push({ name, status: 'failed', tools: [], skipped: 0, error: 'server name may contain only letters, digits, _ and -' });
      return;
    }
    const client = new Client({ name: 'gemmacode', version: '0.0.0' }, { capabilities: {} });
    try {
      const transport =
        'command' in cfg
          ? new StdioClientTransport({
              command: cfg.command,
              args: cfg.args ?? [],
              env: { ...(cleanEnv(process.env) as Record<string, string>), ...(cfg.env ?? {}) },
              cwd: cfg.cwd ?? this.o.cwd,
              stderr: 'ignore',
            })
          : new StreamableHTTPClientTransport(new URL(cfg.url), cfg.headers ? { requestInit: { headers: cfg.headers } } : {});
      await withTimeout(client.connect(transport), this.o.connectTimeoutMs, `connecting to ${name}`);
      const listed = await withTimeout(client.listTools(), this.o.connectTimeoutMs, `listing tools of ${name}`);
      const kept = listed.tools.slice(0, this.o.maxToolsPerServer);
      const tools = kept.map((t) => this.adapt(name, client, t));
      this.servers.push({ name, client, tools });
      this.infos.push({ name, status: 'connected', tools: tools.map((t) => t.name), skipped: listed.tools.length - kept.length });
    } catch (e) {
      await client.close().catch(() => {});
      this.infos.push({ name, status: 'failed', tools: [], skipped: 0, error: (e as Error).message });
    }
  }

  private adapt(server: string, client: Client, t: { name: string; description?: string; inputSchema: unknown }): Tool<any> {
    const toolName = `mcp__${server}__${t.name}`.replace(/[^\w-]/g, '_');
    const schema = normalizeSchema(t.inputSchema);
    const callTimeout = this.o.callTimeoutMs;
    const maxChars = this.o.maxResultChars;
    return {
      name: toolName,
      description: `[${server}] ${(t.description ?? t.name).replace(/\s+/g, ' ').slice(0, 220)}`,
      parameters: schema,
      risk: 'external',
      inspect: (args: Record<string, unknown>) => ({ summary: `${server}.${t.name}(${truncateMiddle(JSON.stringify(args), 120)})` }),
      async run(args: Record<string, unknown>, ctx) {
        try {
          const res = await client.callTool({ name: t.name, arguments: args }, undefined, { timeout: callTimeout, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          const parts = Array.isArray(res.content) ? (res.content as { type: string; text?: string; mimeType?: string }[]) : [];
          const text = parts.map((p) => (p.type === 'text' ? (p.text ?? '') : `[${p.type}${p.mimeType ? ` ${p.mimeType}` : ''} omitted]`)).join('\n');
          return { content: truncateMiddle(text || '(empty result)', maxChars), isError: res.isError === true, untrusted: true };
        } catch (e) {
          return { content: `MCP call failed: ${(e as Error).message}`, isError: true, untrusted: true };
        }
      },
    };
  }
}

/** Схема инструмента в виде, который понимают валидатор и промпт: объект со свойствами; лишние ключи разрешены. */
export function normalizeSchema(raw: unknown): JsonSchemaObject {
  const s = (raw && typeof raw === 'object' ? raw : {}) as { properties?: Record<string, Record<string, unknown>>; required?: unknown };
  const properties: Record<string, JsonSchemaProp> = {};
  for (const [k, p] of Object.entries(s.properties ?? {})) {
    const type = typeof p.type === 'string' ? p.type : Array.isArray(p.type) ? String(p.type.find((x) => x !== 'null') ?? 'string') : 'any';
    properties[k] = {
      type,
      ...(typeof p.description === 'string' ? { description: p.description.slice(0, 160) } : {}),
      ...(Array.isArray(p.enum) && p.enum.every((x) => typeof x === 'string') ? { enum: p.enum as string[] } : {}),
    };
  }
  return { type: 'object', properties, required: Array.isArray(s.required) ? (s.required as string[]).filter((r) => r in properties) : [], additionalProperties: true };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
