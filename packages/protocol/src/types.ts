/**
 * Контракт между окном (renderer) и сервисом агента (host). Только типы и константы: ни Node API, ни DOM.
 * Окно вызывает методы `Methods`, сервис присылает события `HostEvents`. Транспорт (IPC Electron, WebSocket
 * для проверок в браузере) этому файлу не важен.
 */

export type PermissionMode = 'read-only' | 'ask' | 'auto-edit' | 'full';
export type Toolset = 'read' | 'edit' | 'full';
export type BackendStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface ServerSettings {
  /** Готовый llama-server по адресу; если задан, свой процесс не запускается. */
  url?: string;
  binary?: string;
  modelFile?: string;
  /** Проекционный файл мультимодальности (mmproj): без него фото и звук модель не получит. */
  mmproj?: string;
  hf?: string;
  port?: number;
  speculative?: 'none' | 'ngram-simple' | 'ngram-map-k' | 'ngram-mod';
}

export interface Settings {
  mode: PermissionMode;
  toolset: Toolset;
  contextSize: number;
  server: ServerSettings;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  totalMemGB: number;
  home: string;
  settings: Settings;
  /** Модель настроена (адрес сервера или файл весов). */
  configured: boolean;
  recentProjects: string[];
  lastProject?: string;
  lastSession?: string;
}

export interface FoundModel {
  file: string;
  sizeMB: number;
  mmproj?: string;
  quant?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: 'user' | 'project';
}

export interface McpInfo {
  name: string;
  status: string;
  error?: string;
  tools: string[];
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ProjectState {
  path: string;
  name: string;
  sessions: SessionSummary[];
  skills: SkillInfo[];
  mcp: McpInfo[];
  warnings: string[];
  /** Песочница команд: seatbelt, bwrap или none (тогда каждая команда требует подтверждения). */
  sandbox: string;
  isGit: boolean;
}

export interface CheckpointInfo {
  id: number;
  label: string;
  createdAt: string;
  files: number;
}

export interface SessionStats {
  steps: number;
  toolCalls: number;
  invalidCalls: number;
  promptTokens: number;
  generatedTokens: number;
  genTokensPerSecond: number;
}

export interface ContextUsage {
  used: number;
  limit: number;
}

export interface ApprovalRequestWire {
  id: string;
  sessionId: string;
  tool: string;
  summary: string;
  reason: string;
  detail?: string;
  diff?: string;
  grantLabel?: string;
}

export type ApprovalAnswer = 'allow' | 'allow-session' | 'deny';

export interface SessionState {
  id: string;
  title: string;
  feed: FeedItem[];
  checkpoints: CheckpointInfo[];
  stats: SessionStats;
  context: ContextUsage;
  mode: PermissionMode;
  verify?: string;
  running: boolean;
  pendingApprovals: ApprovalRequestWire[];
  /** Файлы проекта (относительные пути), изменённые агентом в этой сессии. */
  touched: string[];
}

// ---------- вложения ----------

export type AttachmentKind = 'image' | 'audio' | 'text' | 'file';

/** Вложение, уже сохранённое в проекте и готовое к отправке. */
export interface AttachmentRef {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Пути относительно корня проекта (у длинного аудио несколько фрагментов). */
  relPaths: string[];
  size: number;
  /** Оценка токенов контекста, которые вложение займёт. */
  estTokens: number;
  note?: string;
}

export interface AttachmentView {
  name: string;
  kind: AttachmentKind;
  relPaths: string[];
  note?: string;
}

/** Сколько секунд аудио модель принимает за один фрагмент и сколько фрагментов разрешаем в одном вложении. */
export const AUDIO_CHUNK_SECONDS = 30;
export const AUDIO_MAX_CHUNKS = 4;
export const IMAGE_MAX_SIDE = 1024;
/** Грубая оценка стоимости медиа в токенах (по данным Gemma: картинка 256 токенов, звук 25 токенов в секунду). */
export const IMAGE_TOKENS = 280;
export const AUDIO_TOKENS_PER_SECOND = 25;

// ---------- файлы ----------

export interface DirEntry {
  name: string;
  /** Путь от корня проекта, с «/» на любой ОС. */
  path: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  /** Каталог, который обычно не нужен (node_modules, сборки): в дереве приглушён. */
  muted?: boolean;
}

export type FileContent =
  | { kind: 'text'; path: string; text: string; size: number; mtime: number; truncated?: boolean }
  | { kind: 'image'; path: string; dataUrl: string; size: number; mtime: number }
  | { kind: 'audio'; path: string; dataUrl: string; size: number; mtime: number }
  | { kind: 'video'; path: string; dataUrl: string; size: number; mtime: number }
  | { kind: 'binary'; path: string; size: number; mtime: number };

export interface SearchHit {
  path: string;
  /** Для поиска по содержимому: номер строки (с 1) и сама строка. */
  line?: number;
  text?: string;
}

export interface GitFileStatus {
  path: string;
  /** Коды `git status --porcelain`: XY. */
  status: string;
}

export interface GitStatus {
  branch: string;
  files: GitFileStatus[];
}

export interface FileChange {
  path: string;
  diff: string;
  created: boolean;
  deleted: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  kind: 'command' | 'skill';
}

// ---------- браузер ----------

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserState {
  /** Есть чем открывать страницы (в приложении всегда; без Electron нужен Chrome или Chromium). */
  available: boolean;
  /** Почему браузер недоступен. */
  reason?: string;
  tabs: BrowserTab[];
  active: string | null;
}

export type BrowserInputWire =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right'; count?: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { kind: 'key'; key: string; code?: string; text?: string; modifiers?: number }
  | { kind: 'text'; text: string };

// ---------- методы ----------

export interface Methods {
  'app.init': { params: Record<string, never>; result: AppInfo };
  'settings.set': { params: Partial<Settings>; result: Settings };
  'models.scan': { params: Record<string, never>; result: FoundModel[] };

  'project.open': { params: { path: string }; result: ProjectState };
  'project.forget': { params: { path: string }; result: null };

  'session.create': { params: Record<string, never>; result: SessionState };
  'session.open': { params: { id: string }; result: SessionState };
  'session.delete': { params: { id: string }; result: SessionSummary[] };
  'session.options': { params: { id: string; mode?: PermissionMode; verify?: string | null }; result: SessionState };
  'session.rollback': { params: { id: string; checkpoint: number }; result: SessionState };
  'session.changes': { params: { id: string; checkpoint?: number }; result: FileChange[] };

  'chat.send': { params: { sessionId: string; text: string; attachments: AttachmentRef[] }; result: { ok: true } };
  'chat.abort': { params: { sessionId: string }; result: null };
  'approval.answer': { params: { id: string; answer: ApprovalAnswer }; result: null };

  'attachment.save': {
    params: { name: string; mime: string; kind: AttachmentKind; parts: string[]; note?: string; estTokens?: number };
    result: AttachmentRef;
  };
  /** Вложение из файла проекта (перетаскивание из файлового менеджера или `@файл`). */
  'attachment.fromProject': { params: { path: string }; result: AttachmentRef };

  'fs.list': { params: { dir: string }; result: DirEntry[] };
  'fs.read': { params: { path: string }; result: FileContent };
  'fs.write': { params: { path: string; text: string }; result: { mtime: number } };
  'fs.create': { params: { path: string; dir?: boolean }; result: null };
  'fs.rename': { params: { from: string; to: string }; result: null };
  'fs.trash': { params: { path: string }; result: null };
  'fs.search': { params: { query: string; mode: 'name' | 'content' }; result: SearchHit[] };
  'git.status': { params: Record<string, never>; result: GitStatus | null };

  'backend.start': { params: Record<string, never>; result: null };
  'backend.stop': { params: Record<string, never>; result: null };
  'commands.list': { params: Record<string, never>; result: CommandInfo[] };

  /** Окно показывает вкладку браузера: сервис начинает слать кадры. */
  'browser.attach': { params: { width: number; height: number }; result: BrowserState };
  'browser.detach': { params: Record<string, never>; result: null };
  /** Пользователь ввёл адрес: сайт, который он открыл сам, становится разрешённым для агента. */
  'browser.open': { params: { url: string; newTab?: boolean }; result: BrowserState };
  'browser.nav': { params: { action: 'back' | 'forward' | 'reload' | 'stop' }; result: BrowserState };
  'browser.tab': { params: { action: 'new' | 'close' | 'activate'; id?: string }; result: BrowserState };
  'browser.input': { params: BrowserInputWire; result: null };
  'browser.viewport': { params: { width: number; height: number }; result: null };

  'term.open': { params: { cols: number; rows: number }; result: { id: string; shell: string } };
  'term.write': { params: { id: string; data: string }; result: null };
  'term.resize': { params: { id: string; cols: number; rows: number }; result: null };
  'term.close': { params: { id: string }; result: null };
}

export type MethodName = keyof Methods;

// ---------- события ----------

/** События хода. Совпадают по форме с событиями ядра (`AgentEvent`, `RunnerEvent`), которые сервис пересылает как есть. */
export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'skill_loaded'; name: string; via: 'command' | 'match' }
  | { type: 'tool_call'; id: string; name: string; summary: string; args: Record<string, unknown> }
  | { type: 'approval'; id: string; answer: ApprovalAnswer | 'auto-denied'; reason: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean; touched: string[]; ms: number; diff?: string }
  | { type: 'fallback'; reason: string }
  | { type: 'nudge'; reason: string }
  | { type: 'invalid_call'; name: string; error: string; attempt: number }
  | { type: 'compaction'; stage: 'elide' | 'summary'; before: number; after: number }
  | { type: 'timings'; timings: { promptTokens: number; cachedTokens: number; promptTokensPerSecond: number; predictedTokens: number; predictedTokensPerSecond: number } }
  | { type: 'done'; reason: 'completed' | 'max_steps' | 'aborted' | 'invalid_tool_calls' | 'loop_detected' | 'error'; steps: number; message?: string }
  | { type: 'iteration'; n: number; max: number; reason: 'start' | 'verify_failed' | 'review_issues' }
  | { type: 'verify'; iteration: number; command: string; passed: boolean; exitCode: number | null; output: string }
  | { type: 'review'; round: number; verdict: 'ok' | 'issues' | 'skipped'; issues: unknown[]; dropped: number }
  | { type: 'run_done'; outcome: string; iterations: number; reviewRounds: number };

export interface HostEvents {
  'backend.status': { status: BackendStatus; message?: string; model?: string };
  /** Ход начался: окно показывает сообщение пользователя до первых событий модели. */
  'turn.start': { sessionId: string; item: FeedItem };
  'turn.event': { sessionId: string; event: TurnEvent };
  /** Ход закончился (успешно или нет): актуальные цифры сессии. */
  'turn.end': { sessionId: string; stats: SessionStats; context: ContextUsage; checkpoints: CheckpointInfo[]; touched: string[]; title: string };
  'approval.request': ApprovalRequestWire;
  'approval.resolved': { id: string };
  /** Файлы проекта изменились (агентом или откатом): дереву и открытым вкладкам пора обновиться. */
  'fs.changed': { paths: string[]; source: 'agent' | 'rollback' | 'external' };
  'sessions.changed': { sessions: SessionSummary[] };
  'browser.state': BrowserState;
  'browser.frame': { tab: string; data: string; width: number; height: number };
  'browser.blocked': { url: string; reason: string };
  'term.data': { id: string; data: string };
  'term.exit': { id: string; code: number | null };
}

export type HostEventName = keyof HostEvents;

export type WireRequest = { id: number; method: string; params: unknown };
export type WireResponse = { id: number; result: unknown } | { id: number; error: { message: string } };
export type WireEvent = { event: string; data: unknown };
export type WireMessage = WireResponse | WireEvent;

// ---------- лента ----------

export type FeedItem =
  | { kind: 'user'; id: string; text: string; attachments: AttachmentView[]; checkpoint?: number }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      args: Record<string, unknown>;
      status: 'running' | 'ok' | 'error' | 'denied';
      result?: string;
      diff?: string;
      ms?: number;
      touched?: string[];
    }
  | { kind: 'note'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'verify'; id: string; command: string; passed: boolean; output: string; iteration: number };
