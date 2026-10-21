import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  Agent,
  McpManager,
  PermissionPolicy,
  SessionStore,
  SkillCatalog,
  SnapshotStore,
  createBackend,
  createRegistry,
  detectSandbox,
  detectVerifyCommand,
  loadConfig,
  runTask,
  unifiedDiff,
  type ApprovalAnswer as CoreApprovalAnswer,
  type GemmaConfig,
  type InferenceBackend,
  type RunOptions,
} from '@gemmacode/core';
import type {
  AppInfo,
  ApprovalAnswer,
  ApprovalRequestWire,
  AttachmentRef,
  BackendStatus,
  CheckpointInfo,
  CommandInfo,
  FeedItem,
  FileChange,
  HostEventName,
  HostEvents,
  MethodName,
  Methods,
  PermissionMode,
  ProjectState,
  SessionState,
  SessionSummary,
  Settings,
  StoredMessage,
  TurnEvent,
} from '@gemmacode/protocol';
import { applyTurnEvent, feedFromMessages } from '@gemmacode/protocol';
import { attachmentFromProjectFile, buildUserContent, saveAttachment } from './attachments.ts';
import { patchUserConfig, readAppMemory, scanModels, writeAppMemory } from './config-store.ts';
import { ProjectFiles, toPosix, type Platform } from './files.ts';
import { Terminals } from './terminal.ts';

export interface HostOptions {
  home?: string;
  version?: string;
  platform?: Platform;
  /** Подмена движка (тесты). Возвращает null, если модель не настроена. */
  backendFactory?: (config: GemmaConfig) => InferenceBackend | null;
  /** Подмена загрузчика node-pty (тесты). */
  ptyLoader?: ConstructorParameters<typeof Terminals>[1];
  /** Следить за файлами проекта и сообщать окну об изменениях извне. */
  watchFiles?: boolean;
}

type Listener = (event: string, data: unknown) => void;
type Handlers = { [K in MethodName]: (params: Methods[K]['params']) => Promise<Methods[K]['result']> | Methods[K]['result'] };

interface Pending {
  req: ApprovalRequestWire;
  resolve(a: CoreApprovalAnswer): void;
}

class LiveSession {
  feed: FeedItem[] = [];
  running = false;
  abort: AbortController | undefined;
  readonly pending = new Map<string, Pending>();
  readonly touched = new Set<string>();
  verify: string | undefined;

  readonly id: string;
  readonly agent: Agent;
  readonly snapshots: SnapshotStore;
  readonly policy: PermissionPolicy;

  constructor(id: string, agent: Agent, snapshots: SnapshotStore, policy: PermissionPolicy) {
    this.id = id;
    this.agent = agent;
    this.snapshots = snapshots;
    this.policy = policy;
  }
}

interface ProjectParts {
  cwd: string;
  config: GemmaConfig;
  backend: InferenceBackend | null;
  files: ProjectFiles;
  skills: SkillCatalog;
  mcp: McpManager;
  store: SessionStore;
  warnings: string[];
  sandbox: ReturnType<typeof detectSandbox>;
}

class Project {
  readonly live = new Map<string, LiveSession>();
  starting: Promise<void> | undefined;
  status: BackendStatus = 'stopped';
  watcher: FSWatcher | undefined;
  readonly cwd: string;
  config: GemmaConfig;
  backend: InferenceBackend | null;
  readonly files: ProjectFiles;
  readonly skills: SkillCatalog;
  readonly mcp: McpManager;
  readonly store: SessionStore;
  readonly warnings: string[];
  readonly sandbox: ReturnType<typeof detectSandbox>;

  constructor(parts: ProjectParts) {
    this.cwd = parts.cwd;
    this.config = parts.config;
    this.backend = parts.backend;
    this.files = parts.files;
    this.skills = parts.skills;
    this.mcp = parts.mcp;
    this.store = parts.store;
    this.warnings = parts.warnings;
    this.sandbox = parts.sandbox;
  }
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: 'mode', description: 'Права: read-only, ask, auto-edit, full', kind: 'command' },
  { name: 'verify', description: 'Проверка после задачи: /verify npm test | auto | off', kind: 'command' },
  { name: 'undo', description: 'Откатить последний ход', kind: 'command' },
  { name: 'diff', description: 'Показать изменения сессии', kind: 'command' },
  { name: 'new', description: 'Новая сессия', kind: 'command' },
  { name: 'context', description: 'Занятость контекста', kind: 'command' },
];

export class AgentHost {
  private readonly opts: HostOptions;
  private readonly home: string;
  private readonly listeners = new Set<Listener>();
  private project: Project | undefined;
  private activeTurn: LiveSession | undefined;
  private readonly terminals: Terminals;
  private readonly handlers: Handlers;

  constructor(opts: HostOptions = {}) {
    this.opts = opts;
    this.home = opts.home ?? homedir();
    this.terminals = new Terminals(
      { data: (id, data) => this.emit('term.data', { id, data }), exit: (id, code) => this.emit('term.exit', { id, code }) },
      opts.ptyLoader,
    );
    this.handlers = this.buildHandlers();
  }

  onEvent(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit<K extends HostEventName>(event: K, data: HostEvents[K]): void {
    for (const l of this.listeners) l(event, data);
  }

  async call<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    const h = this.handlers[method] as ((p: Methods[M]['params']) => Promise<Methods[M]['result']>) | undefined;
    if (!h) throw new Error(`Неизвестный метод ${method}`);
    return h(params);
  }

  // ---------- настройки ----------

  private settingsOf(c: GemmaConfig): Settings {
    return { mode: c.mode, toolset: c.toolset, contextSize: c.contextSize, server: { ...c.server } };
  }

  private userSettings(): Settings {
    return this.settingsOf(loadConfig(join(this.home, '.gemmacode', 'no-project'), this.home).config);
  }

  private appInfo(): AppInfo {
    const settings = this.project ? this.settingsOf(this.project.config) : this.userSettings();
    const mem = readAppMemory(this.home);
    return {
      version: this.opts.version ?? '0.0.0',
      platform: process.platform,
      arch: process.arch,
      totalMemGB: Math.round(totalmem() / 2 ** 30),
      home: this.home,
      settings,
      configured: Boolean(settings.server.url || settings.server.modelFile || settings.server.hf),
      recentProjects: mem.recentProjects.filter((p) => existsSync(p)),
      ...(mem.lastProject ? { lastProject: mem.lastProject } : {}),
      ...(mem.lastSession ? { lastSession: mem.lastSession } : {}),
    };
  }

  // ---------- движок ----------

  private makeBackend(c: GemmaConfig): InferenceBackend | null {
    return this.opts.backendFactory ? this.opts.backendFactory(c) : createBackend(c.server, c.contextSize);
  }

  private setStatus(p: Project, status: BackendStatus, message?: string): void {
    p.status = status;
    const model = p.config.server.modelFile ? basename(p.config.server.modelFile) : p.config.server.url ?? p.config.server.hf;
    this.emit('backend.status', { status, ...(message ? { message } : {}), ...(model ? { model } : {}) });
  }

  private ensureBackend(p: Project): Promise<void> {
    if (!p.backend) return Promise.reject(new Error('Модель не настроена. Откройте настройки и укажите файл модели (GGUF) или адрес llama-server.'));
    if (p.backend.status === 'ready') {
      if (p.status !== 'ready') this.setStatus(p, 'ready');
      return Promise.resolve();
    }
    if (p.starting) return p.starting;
    const backend = p.backend;
    this.setStatus(p, 'starting');
    p.starting = backend.start().then(
      () => this.setStatus(p, 'ready'),
      (e: Error) => {
        this.setStatus(p, 'error', e.message.split('\n').slice(0, 6).join('\n'));
        throw e;
      },
    ).finally(() => {
      p.starting = undefined;
    });
    return p.starting;
  }

  // ---------- проект ----------

  private async openProject(path: string): Promise<ProjectState> {
    const cwd = resolve(path);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Папка не найдена: ${cwd}`);
    await this.closeProject();
    const loaded = loadConfig(cwd, this.home);
    const skills = SkillCatalog.load(cwd, this.home);
    const mcp = new McpManager({ cwd });
    const warnings = [...loaded.warnings];
    if (Object.keys(loaded.config.mcpServers).length) {
      for (const info of await mcp.connect(loaded.config.mcpServers)) if (info.status === 'failed') warnings.push(`MCP ${info.name}: ${info.error}`);
    }
    const sandbox = detectSandbox();
    if (sandbox.kind === 'none') warnings.push('Песочницы ОС нет: каждая команда shell потребует подтверждения.');
    const p = new Project({ cwd, config: loaded.config, backend: this.makeBackend(loaded.config), files: new ProjectFiles(cwd, this.opts.platform), skills, mcp, store: new SessionStore(cwd), warnings, sandbox });
    this.project = p;
    excludeFromGit(cwd);
    if (this.opts.watchFiles) this.watchProject(p);

    const mem = readAppMemory(this.home);
    writeAppMemory(this.home, { ...mem, recentProjects: [cwd, ...mem.recentProjects.filter((x) => x !== cwd)].slice(0, 12), lastProject: cwd });

    if (p.backend) void this.ensureBackend(p).catch(() => undefined);
    else this.setStatus(p, 'stopped', 'Модель не настроена');
    return this.projectState(p);
  }

  private projectState(p: Project): ProjectState {
    return {
      path: p.cwd,
      name: basename(p.cwd),
      sessions: this.sessionList(p),
      skills: p.skills.list().map((s) => ({ name: s.name, description: s.description, scope: s.scope })),
      mcp: p.mcp.info().map((i) => ({ name: i.name, status: i.status, ...(i.error ? { error: i.error } : {}), tools: i.tools })),
      warnings: p.warnings,
      sandbox: p.sandbox.kind,
      isGit: existsSync(join(p.cwd, '.git')),
    };
  }

  private sessionList(p: Project): SessionSummary[] {
    return p.store.list().map((s) => ({ id: s.id, title: s.title || 'Новая сессия', updatedAt: s.updatedAt }));
  }

  private async closeProject(): Promise<void> {
    const p = this.project;
    if (!p) return;
    this.project = undefined;
    p.watcher?.close();
    for (const s of p.live.values()) {
      s.abort?.abort();
      for (const pend of s.pending.values()) pend.resolve('deny');
    }
    this.terminals.closeAll();
    this.activeTurn = undefined;
    await p.mcp.close().catch(() => undefined);
    await p.backend?.stop().catch(() => undefined);
    this.emit('backend.status', { status: 'stopped' });
  }

  private watchProject(p: Project): void {
    let timer: NodeJS.Timeout | undefined;
    const changed = new Set<string>();
    try {
      p.watcher = watch(p.cwd, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const rel = toPosix(String(name));
        if (/(^|\/)(\.git|\.gemmacode|node_modules|\.DS_Store)(\/|$)/.test(rel)) return;
        changed.add(rel);
        timer ??= setTimeout(() => {
          timer = undefined;
          const paths = [...changed].slice(0, 200);
          changed.clear();
          this.emit('fs.changed', { paths, source: 'external' });
        }, 400);
      });
      p.watcher.on('error', () => undefined);
    } catch {
      // наблюдение недоступно (например, лимит inotify): дерево обновится вручную
    }
  }

  // ---------- сессии ----------

  private need(): Project {
    if (!this.project) throw new Error('Проект не открыт');
    return this.project;
  }

  private session(p: Project, id: string): LiveSession {
    const existing = p.live.get(id);
    if (existing) return existing;
    const registry = createRegistry(p.config.toolset, { skills: p.skills.size > 0 });
    for (const t of p.mcp.tools()) registry.register(t);
    const policy = new PermissionPolicy({ mode: p.config.mode, cwd: p.cwd, sandboxEnforced: p.sandbox.enforced, rules: p.config.permissions });
    const snapshots = new SnapshotStore(p.cwd, id);
    const backend = p.backend;
    if (!backend) throw new Error('Модель не настроена');
    let live!: LiveSession;
    const agent = new Agent({
      backend,
      cwd: p.cwd,
      registry,
      policy,
      sandbox: p.sandbox,
      skills: p.skills,
      snapshots,
      store: p.store,
      sessionId: id,
      toolCallMode: p.config.toolCallMode,
      skillRouting: p.config.skillRouting,
      contextSize: p.config.contextSize,
      maxSteps: p.config.maxSteps,
      approve: (req) => this.requestApproval(live, req),
    });
    live = new LiveSession(id, agent, snapshots, policy);
    live.feed = feedFromMessages(agent.messages as unknown as StoredMessage[]);
    for (const f of snapshots.changedSince(1)) live.touched.add(f);
    p.live.set(id, live);
    return live;
  }

  private requestApproval(live: LiveSession, req: Parameters<NonNullable<ConstructorParameters<typeof Agent>[0]['approve']>>[0]): Promise<CoreApprovalAnswer> {
    const id = `ap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const wire: ApprovalRequestWire = {
      id,
      sessionId: live.id,
      tool: req.tool,
      summary: req.summary,
      reason: req.reason,
      ...(req.detail ? { detail: req.detail } : {}),
      ...(req.diff ? { diff: req.diff } : {}),
      ...(req.grantLabel ? { grantLabel: req.grantLabel } : {}),
    };
    return new Promise((resolveAnswer) => {
      live.pending.set(id, { req: wire, resolve: resolveAnswer });
      this.emit('approval.request', wire);
    });
  }

  private stateOf(p: Project, live: LiveSession): SessionState {
    const agent = live.agent;
    const first = agent.messages.find((m) => m.role === 'user');
    return {
      id: live.id,
      title: first ? titleOf(first) : 'Новая сессия',
      feed: live.feed,
      checkpoints: checkpointsOf(live),
      stats: { ...agent.stats },
      context: { used: agent.contextTokens(), limit: p.config.contextSize },
      mode: live.policy.mode,
      ...(live.verify ? { verify: live.verify } : {}),
      running: live.running,
      pendingApprovals: [...live.pending.values()].map((x) => x.req),
      touched: [...live.touched].sort(),
    };
  }

  private async send(sessionId: string, text: string, attachments: AttachmentRef[]): Promise<{ ok: true }> {
    const p = this.need();
    if (this.activeTurn) throw new Error('Агент занят другим ходом. Дождитесь его завершения или остановите.');
    if (!text.trim() && !attachments.length) throw new Error('Пустое сообщение');
    await this.ensureBackend(p);
    const live = this.session(p, sessionId);
    const built = buildUserContent(p.cwd, text, attachments);
    if (built.hasMedia && !p.config.server.url && !p.config.server.mmproj) {
      throw new Error('Модель запущена без проектора мультимодальности (mmproj), поэтому фото и звук недоступны. Укажите файл mmproj в настройках модели.');
    }
    this.activeTurn = live;
    live.running = true;
    live.abort = new AbortController();
    const checkpoint = live.snapshots.list().length + 1;
    const item: FeedItem = { kind: 'user', id: `u${Date.now().toString(36)}`, text, attachments: built.ui.attachments.map((a) => ({ name: a.name, kind: a.kind as AttachmentRef['kind'], relPaths: a.relPaths, ...(a.note ? { note: a.note } : {}) })), checkpoint };
    live.feed = [...live.feed, item];
    this.emit('turn.start', { sessionId, item });
    void this.runTurn(p, live, built.content, built.ui, text);
    return { ok: true };
  }

  private async runTurn(p: Project, live: LiveSession, content: Parameters<Agent['send']>[0], ui: NonNullable<RunOptions['ui']>, text: string): Promise<void> {
    const opts: RunOptions = {
      ui,
      ...(live.verify ? { verify: live.verify, maxIterations: p.config.maxIterations } : {}),
    };
    try {
      for await (const e of runTask(live.agent, content, opts, live.abort?.signal)) {
        const event = e as TurnEvent;
        live.feed = applyTurnEvent(live.feed, event);
        if (e.type === 'tool_result' && e.touched.length) {
          const rel = e.touched.map((a) => toPosix(p.files.rel(a))).filter((r) => !r.startsWith('..'));
          rel.forEach((r) => live.touched.add(r));
          if (rel.length) this.emit('fs.changed', { paths: rel, source: 'agent' });
        }
        this.emit('turn.event', { sessionId: live.id, event });
      }
    } catch (err) {
      const event: TurnEvent = { type: 'done', reason: 'error', steps: 0, message: (err as Error).message };
      live.feed = applyTurnEvent(live.feed, event);
      this.emit('turn.event', { sessionId: live.id, event });
    } finally {
      live.running = false;
      live.abort = undefined;
      for (const [id, pend] of live.pending) {
        pend.resolve('deny');
        this.emit('approval.resolved', { id });
      }
      live.pending.clear();
      if (this.activeTurn === live) this.activeTurn = undefined;
      const s = this.stateOf(p, live);
      this.emit('turn.end', { sessionId: live.id, stats: s.stats, context: s.context, checkpoints: s.checkpoints, touched: s.touched, title: s.title || text.slice(0, 80) });
      this.emit('sessions.changed', { sessions: this.sessionList(p) });
      if (p.backend && p.backend.status !== 'ready' && p.status === 'ready') this.setStatus(p, p.backend.status === 'error' ? 'error' : 'stopped', 'Движок остановился. Он запустится заново при следующем сообщении.');
    }
  }

  private async rollback(id: string, checkpoint: number): Promise<SessionState> {
    const p = this.need();
    const live = this.session(p, id);
    if (live.running) throw new Error('Дождитесь завершения хода или остановите его.');
    const cp = live.snapshots.list().find((c) => c.id === checkpoint);
    if (!cp) throw new Error('Контрольная точка не найдена');
    const { files, historyTrimmed } = live.agent.rollbackTo(checkpoint);
    live.feed = historyTrimmed ? feedFromMessages(live.agent.messages as unknown as StoredMessage[]) : live.feed;
    live.feed = [
      ...live.feed,
      { kind: 'note', id: `n${Date.now().toString(36)}`, level: 'info', text: files.length ? `Откат: файлы возвращены к состоянию до хода «${cp.label}» (${files.join(', ')}).` : `Откат к ходу «${cp.label}»: файлы не менялись.` },
    ];
    live.touched.clear();
    for (const f of live.snapshots.changedSince(1)) live.touched.add(f);
    if (files.length) this.emit('fs.changed', { paths: files, source: 'rollback' });
    this.emit('sessions.changed', { sessions: this.sessionList(p) });
    return this.stateOf(p, live);
  }

  private changes(id: string, checkpoint?: number): FileChange[] {
    const p = this.need();
    const live = this.session(p, id);
    if (checkpoint !== undefined) return live.snapshots.checkpointChanges(checkpoint);
    const out: FileChange[] = [];
    for (const rel of live.snapshots.changedSince(1)) {
      const before = live.snapshots.originalText(rel, 1);
      const abs = join(p.cwd, rel);
      const after = existsSync(abs) ? safeRead(abs) : null;
      if (before === after) continue;
      const diff = unifiedDiff(rel, before, after);
      if (diff) out.push({ path: rel, diff, created: before === null, deleted: after === null });
    }
    return out;
  }

  // ---------- методы ----------

  private buildHandlers(): Handlers {
    const files = () => this.need().files;
    return {
      'app.init': () => this.appInfo(),
      'settings.set': async (patch) => {
        patchUserConfig(this.home, patch);
        const p = this.project;
        if (p) {
          const fresh = loadConfig(p.cwd, this.home).config;
          const serverChanged = JSON.stringify(fresh.server) !== JSON.stringify(p.config.server) || fresh.contextSize !== p.config.contextSize;
          p.config = fresh;
          if (serverChanged) {
            if (this.activeTurn) throw new Error('Настройки сохранены, но модель нельзя перезапустить во время хода. Перезапустите её позже.');
            await p.backend?.stop().catch(() => undefined);
            p.backend = this.makeBackend(fresh);
            p.live.clear();
            if (p.backend) void this.ensureBackend(p).catch(() => undefined);
            else this.setStatus(p, 'stopped', 'Модель не настроена');
          }
        }
        return this.appInfo().settings;
      },
      'models.scan': () => scanModels(this.home),
      'project.open': ({ path }) => this.openProject(path),
      'project.forget': ({ path }) => {
        const mem = readAppMemory(this.home);
        writeAppMemory(this.home, { ...mem, recentProjects: mem.recentProjects.filter((x) => x !== path) });
        return null;
      },

      'session.create': () => {
        const p = this.need();
        const live = this.session(p, SessionStore.newId());
        return this.stateOf(p, live);
      },
      'session.open': ({ id }) => {
        const p = this.need();
        const live = this.session(p, id);
        writeAppMemory(this.home, { ...readAppMemory(this.home), lastSession: id });
        return this.stateOf(p, live);
      },
      'session.delete': ({ id }) => {
        const p = this.need();
        const live = p.live.get(id);
        if (live?.running) throw new Error('Сессия выполняется: остановите её перед удалением.');
        p.live.delete(id);
        p.store.delete(id);
        return this.sessionList(p);
      },
      'session.options': ({ id, mode, verify }) => {
        const p = this.need();
        const live = this.session(p, id);
        if (mode) live.policy.mode = mode as PermissionMode;
        if (verify !== undefined) {
          if (verify === null || verify === 'off' || verify === '') live.verify = undefined;
          else if (verify === 'auto') {
            const cmd = detectVerifyCommand(p.cwd);
            if (!cmd) throw new Error('Не нашёл команду проверки в проекте. Укажите её явно: /verify npm test');
            live.verify = cmd;
          } else live.verify = verify;
        }
        return this.stateOf(p, live);
      },
      'session.rollback': ({ id, checkpoint }) => this.rollback(id, checkpoint),
      'session.changes': ({ id, checkpoint }) => this.changes(id, checkpoint),

      'chat.send': ({ sessionId, text, attachments }) => this.send(sessionId, text, attachments),
      'chat.abort': ({ sessionId }) => {
        const live = this.project?.live.get(sessionId);
        live?.abort?.abort();
        for (const [pid, pend] of live?.pending ?? []) {
          pend.resolve('deny');
          this.emit('approval.resolved', { id: pid });
        }
        live?.pending.clear();
        return null;
      },
      'approval.answer': ({ id, answer }) => {
        for (const live of this.project?.live.values() ?? []) {
          const pend = live.pending.get(id);
          if (!pend) continue;
          live.pending.delete(id);
          pend.resolve(answer as ApprovalAnswer);
          this.emit('approval.resolved', { id });
        }
        return null;
      },

      'attachment.save': (a) => saveAttachment(this.need().cwd, a),
      'attachment.fromProject': ({ path }) => attachmentFromProjectFile(this.need().cwd, path),

      'fs.list': ({ dir }) => files().list(dir),
      'fs.read': ({ path }) => files().read(path),
      'fs.write': ({ path, text }) => files().write(path, text),
      'fs.create': ({ path, dir }) => {
        files().create(path, dir);
        return null;
      },
      'fs.rename': ({ from, to }) => {
        files().rename(from, to);
        return null;
      },
      'fs.trash': async ({ path }) => {
        await files().trash(path);
        return null;
      },
      'fs.search': ({ query, mode }) => files().search(query, mode),
      'git.status': () => files().gitStatus(),

      'backend.start': async () => {
        await this.ensureBackend(this.need());
        return null;
      },
      'backend.stop': async () => {
        const p = this.need();
        await p.backend?.stop();
        this.setStatus(p, 'stopped');
        return null;
      },
      'commands.list': () => {
        const p = this.need();
        return [
          ...BUILTIN_COMMANDS,
          ...p.skills.list().map((s): CommandInfo => ({ name: s.name, description: s.description, kind: 'skill' })),
        ];
      },

      'term.open': ({ cols, rows }) => this.terminals.open(this.need().cwd, cols, rows),
      'term.write': ({ id, data }) => {
        this.terminals.write(id, data);
        return null;
      },
      'term.resize': ({ id, cols, rows }) => {
        this.terminals.resize(id, cols, rows);
        return null;
      },
      'term.close': ({ id }) => {
        this.terminals.close(id);
        return null;
      },
    };
  }

  async shutdown(): Promise<void> {
    await this.closeProject();
  }
}

function safeRead(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function titleOf(m: { role: string; content?: unknown; ui?: { text: string } }): string {
  const text = m.ui?.text ?? (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join(' ') : '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Новая сессия';
}

function checkpointsOf(live: LiveSession): CheckpointInfo[] {
  return live.snapshots.list().map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, files: Object.keys(c.files).length }));
}

/** Каталог `.gemmacode` (сессии, снимки, вложения) не должен попадать в коммиты: добавляем его в локальный exclude репозитория. */
function excludeFromGit(cwd: string): void {
  try {
    const gitDir = join(cwd, '.git');
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
    const file = join(gitDir, 'info', 'exclude');
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (/^\/?\.gemmacode\/?$/m.test(cur)) return;
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.gemmacode/\n`);
  } catch {
    // не смогли — не страшно, пользователь увидит папку в git status
  }
}
