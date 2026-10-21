import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillRouting } from '../agent/loop.ts';
import type { ToolCallMode } from '../agent/strategy.ts';
import type { McpServerConfig } from '../mcp/manager.ts';
import type { PermissionMode } from '../permissions/policy.ts';
import type { Toolset } from '../tools/registry.ts';

export interface ServerSettings {
  url?: string;
  binary?: string;
  modelFile?: string;
  mmproj?: string;
  hf?: string;
  port?: number;
  speculative?: 'none' | 'ngram-simple' | 'ngram-map-k' | 'ngram-mod';
}

export interface GemmaConfig {
  mode: PermissionMode;
  toolset: Toolset;
  toolCallMode: ToolCallMode;
  skillRouting: SkillRouting;
  contextSize: number;
  maxSteps: number;
  permissions: { allow: string[]; deny: string[] };
  mcpServers: Record<string, McpServerConfig>;
  server: ServerSettings;
  /** Встроенный браузер: путь к Chrome/Chromium для режимов без Electron. */
  browser: { executablePath?: string };
  /** Команда проверки для режима loop: 'auto' — определить по проекту; пусто — выключено. */
  verify?: string;
  review: boolean;
  maxIterations: number;
}

export const DEFAULT_CONFIG: GemmaConfig = {
  mode: 'ask',
  toolset: 'edit',
  toolCallMode: 'native',
  skillRouting: 'auto',
  contextSize: 16384,
  maxSteps: 25,
  permissions: { allow: [], deny: [] },
  mcpServers: {},
  server: {},
  browser: {},
  review: false,
  maxIterations: 4,
};

const MODES = ['read-only', 'ask', 'auto-edit', 'full'];
const TOOLSETS = ['read', 'edit', 'full'];
const TOOL_MODES = ['native', 'schema'];
const ROUTING = ['model', 'explicit', 'auto'];

export function configPaths(cwd: string, home = homedir()): string[] {
  return [join(home, '.gemmacode', 'config.json'), join(cwd, '.gemmacode', 'config.json')];
}

/** Читает пользовательский и проектный конфиг (проектный главнее). Ошибки формата возвращаются списком, а не роняют запуск. */
export function loadConfig(cwd: string, home = homedir()): { config: GemmaConfig; warnings: string[] } {
  const warnings: string[] = [];
  let config: GemmaConfig = { ...DEFAULT_CONFIG, permissions: { allow: [], deny: [] }, mcpServers: {}, server: {}, browser: {} };
  for (const file of configPaths(cwd, home)) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      config = merge(config, raw, file, warnings);
    } catch (e) {
      warnings.push(`${file}: ${(e as Error).message}`);
    }
  }
  return { config, warnings };
}

function merge(base: GemmaConfig, raw: Record<string, unknown>, file: string, warnings: string[]): GemmaConfig {
  const out: GemmaConfig = { ...base, permissions: { ...base.permissions }, mcpServers: { ...base.mcpServers }, server: { ...base.server }, browser: { ...base.browser } };
  const pick = <T extends string>(key: string, allowed: string[]): T | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string' && allowed.includes(v)) return v as T;
    warnings.push(`${file}: "${key}" must be one of ${allowed.join(', ')}`);
    return undefined;
  };
  out.mode = pick<PermissionMode>('mode', MODES) ?? out.mode;
  out.toolset = pick<Toolset>('toolset', TOOLSETS) ?? out.toolset;
  out.toolCallMode = pick<ToolCallMode>('toolCallMode', TOOL_MODES) ?? out.toolCallMode;
  out.skillRouting = pick<SkillRouting>('skillRouting', ROUTING) ?? out.skillRouting;
  for (const key of ['contextSize', 'maxSteps', 'maxIterations'] as const) {
    const v = raw[key];
    if (typeof v === 'number' && v > 0) out[key] = v;
    else if (v !== undefined) warnings.push(`${file}: "${key}" must be a positive number`);
  }
  if (typeof raw.verify === 'string') out.verify = raw.verify;
  if (typeof raw.review === 'boolean') out.review = raw.review;
  const perms = raw.permissions as { allow?: unknown; deny?: unknown } | undefined;
  if (perms) {
    if (Array.isArray(perms.allow)) out.permissions.allow = [...out.permissions.allow, ...perms.allow.map(String)];
    if (Array.isArray(perms.deny)) out.permissions.deny = [...out.permissions.deny, ...perms.deny.map(String)];
  }
  if (raw.mcpServers && typeof raw.mcpServers === 'object') {
    for (const [name, cfg] of Object.entries(raw.mcpServers as Record<string, McpServerConfig>)) {
      if (cfg && typeof cfg === 'object' && ('command' in cfg || 'url' in cfg)) out.mcpServers[name] = cfg;
      else warnings.push(`${file}: mcpServers.${name} needs "command" or "url"`);
    }
  }
  const br = raw.browser as { executablePath?: unknown } | undefined;
  if (br && typeof br.executablePath === 'string') out.browser.executablePath = br.executablePath;
  if (raw.server && typeof raw.server === 'object') out.server = { ...out.server, ...(raw.server as ServerSettings) };
  return out;
}
