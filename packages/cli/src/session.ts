import { resolve } from 'node:path';
import {
  Agent,
  McpManager,
  PermissionPolicy,
  SessionStore,
  SkillCatalog,
  SnapshotStore,
  createRegistry,
  detectSandbox,
  loadConfig,
  type ApprovalAnswer,
  type ApprovalRequest,
  type GemmaConfig,
  type InferenceBackend,
} from '@gemmacode/core';
import { createBackend, NO_MODEL_HELP } from './backend.ts';
import type { CliOptions } from './args.ts';

export interface Session {
  cwd: string;
  config: GemmaConfig;
  backend: InferenceBackend;
  agent: Agent;
  policy: PermissionPolicy;
  skills: SkillCatalog;
  mcp: McpManager;
  snapshots: SnapshotStore;
  store: SessionStore;
  warnings: string[];
  /** Закрывает MCP и останавливает движок, если процесс наш. */
  close(): Promise<void>;
}

export function applyOptions(config: GemmaConfig, o: CliOptions): GemmaConfig {
  return {
    ...config,
    ...(o.mode ? { mode: o.mode } : {}),
    ...(o.toolset ? { toolset: o.toolset } : {}),
    ...(o.toolCallMode ? { toolCallMode: o.toolCallMode } : {}),
    ...(o.skillRouting ? { skillRouting: o.skillRouting } : {}),
    ...(o.contextSize ? { contextSize: o.contextSize } : {}),
    ...(o.verify !== undefined ? { verify: o.verify } : {}),
    ...(o.review ? { review: true } : {}),
    ...(o.maxIterations ? { maxIterations: o.maxIterations } : {}),
    server: { ...config.server, ...o.server },
  };
}

export async function openSession(o: CliOptions, approve: ((r: ApprovalRequest) => Promise<ApprovalAnswer>) | undefined): Promise<Session> {
  const cwd = resolve(o.cwd);
  const loaded = loadConfig(cwd);
  const config = applyOptions(loaded.config, o);
  const backend = createBackend(config.server, config.contextSize);
  if (!backend) throw new Error(NO_MODEL_HELP);
  await backend.start();

  const skills = SkillCatalog.load(cwd);
  const mcp = new McpManager({ cwd });
  const warnings = [...loaded.warnings];
  if (Object.keys(config.mcpServers).length) {
    for (const info of await mcp.connect(config.mcpServers)) {
      if (info.status === 'failed') warnings.push(`MCP ${info.name}: ${info.error}`);
    }
  }
  const registry = createRegistry(config.toolset, { skills: skills.size > 0 });
  for (const t of mcp.tools()) registry.register(t);

  const sandbox = detectSandbox();
  const policy = new PermissionPolicy({ mode: config.mode, cwd, sandboxEnforced: sandbox.enforced, rules: config.permissions });
  const store = new SessionStore(cwd);
  let sessionId = SessionStore.newId();
  if (o.resume) {
    const sessions = store.list();
    const found = o.resume === true ? sessions[0] : sessions.find((s) => s.id === o.resume || s.id.startsWith(String(o.resume)));
    if (!found) throw new Error('Сессия для продолжения не найдена.');
    sessionId = found.id;
  }
  const snapshots = new SnapshotStore(cwd, sessionId);
  const agent = new Agent({
    backend, cwd, registry, policy, sandbox, skills, snapshots, store, sessionId,
    toolCallMode: config.toolCallMode,
    skillRouting: config.skillRouting,
    contextSize: config.contextSize,
    maxSteps: config.maxSteps,
    ...(approve ? { approve } : {}),
  });
  if (sandbox.kind === 'none') warnings.push('Песочницы ОС нет: каждая команда shell потребует подтверждения.');
  return {
    cwd, config, backend, agent, policy, skills, mcp, snapshots, store, warnings,
    async close() {
      await mcp.close();
      await backend.stop();
    },
  };
}
