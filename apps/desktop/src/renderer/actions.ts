import type { ApprovalAnswer, AttachmentRef, PermissionMode, Settings } from '@gemmacode/protocol';
import { bridge } from './bridge';
import { getState, setState, toast, type RightTab } from './store';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast(msg(e), 'error');
    return undefined;
  }
}

export async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const info = await guard(bridge.call('app.init', {}));
  if (!info) return setState({ booted: true });
  setState({ info, booted: true });
  void refreshModel();
  const auto = params.get('project') ?? (bridge.kind === 'electron' ? info.lastProject : undefined);
  if (auto) await openProject(auto, params.get('project') ? undefined : info.lastSession);
}

export async function refreshModel(modelId?: string): Promise<void> {
  const model = await bridge.call('model.status', modelId ? { modelId } : {}).catch(() => undefined);
  if (model) setState({ model });
}

export async function downloadModel(withMmproj: boolean, modelId?: string): Promise<void> {
  const model = await guard(bridge.call('model.download', { withMmproj, ...(modelId ? { modelId } : {}) }));
  if (model) setState({ model });
}

export async function cancelModelDownload(): Promise<void> {
  const model = await guard(bridge.call('model.cancel', {}));
  if (model) setState({ model });
}

export async function pickAndOpenProject(): Promise<void> {
  const path = await bridge.pickPath({ kind: 'folder', title: 'Папка проекта' });
  if (path) await openProject(path);
}

export async function openProject(path: string, sessionId?: string): Promise<void> {
  const project = await guard(bridge.call('project.open', { path }));
  if (!project) return;
  setState({ project, sessions: project.sessions, session: null, approvals: [], openFiles: [], tab: 'files', git: null, changes: [], speed: 0 });
  void guard(bridge.call('commands.list', {})).then((commands) => commands && setState({ commands }));
  const known = sessionId && project.sessions.some((s) => s.id === sessionId) ? sessionId : undefined;
  if (known) await selectSession(known);
  else await newSession();
  void refreshGit();
  void bridge.call('app.init', {}).then((info) => setState({ info }), () => undefined);
}

export async function newSession(): Promise<void> {
  const cur = getState().session;
  // пустую сессию не плодим: если текущая ещё без сообщений, остаёмся в ней
  if (cur && cur.feed.length === 0 && !cur.running) return;
  const session = await guard(bridge.call('session.create', {}));
  if (!session) return;
  setState({ session, approvals: [], changes: [], changesScope: 'all', speed: 0 });
}

export async function selectSession(id: string): Promise<void> {
  const session = await guard(bridge.call('session.open', { id }));
  if (!session) return;
  setState({ session, approvals: session.pendingApprovals, changes: [], changesScope: 'all', speed: 0 });
  void refreshChanges();
}

export async function deleteSession(id: string): Promise<void> {
  const sessions = await guard(bridge.call('session.delete', { id }));
  if (!sessions) return;
  setState({ sessions });
  if (getState().session?.id === id) {
    setState({ session: null });
    await newSession();
  }
}

export async function sendMessage(text: string, attachments: AttachmentRef[]): Promise<boolean> {
  const s = getState().session;
  if (!s) return false;
  try {
    await bridge.call('chat.send', { sessionId: s.id, text, attachments });
    return true;
  } catch (e) {
    toast(msg(e), 'error');
    return false;
  }
}

export async function abort(): Promise<void> {
  const s = getState().session;
  if (s) await guard(bridge.call('chat.abort', { sessionId: s.id }));
}

export async function answerApproval(id: string, answer: ApprovalAnswer): Promise<void> {
  setState((st) => ({ approvals: st.approvals.filter((a) => a.id !== id) }));
  await guard(bridge.call('approval.answer', { id, answer }));
}

export async function setMode(mode: PermissionMode): Promise<void> {
  const s = getState().session;
  if (!s) return;
  const next = await guard(bridge.call('session.options', { id: s.id, mode }));
  if (next) setState((st) => (st.session ? { session: { ...st.session, mode: next.mode } } : {}));
}

export async function setVerify(verify: string | null): Promise<void> {
  const s = getState().session;
  if (!s) return;
  const next = await guard(bridge.call('session.options', { id: s.id, verify }));
  if (next) setState((st) => (st.session ? { session: { ...st.session, ...(next.verify ? { verify: next.verify } : { verify: undefined }) } } : {}));
  toast(next?.verify ? `Проверка после задачи: ${next.verify}` : 'Проверка выключена');
}

export async function rollback(checkpoint: number): Promise<void> {
  const s = getState().session;
  if (!s) return;
  const next = await guard(bridge.call('session.rollback', { id: s.id, checkpoint }));
  if (!next) return;
  setState({ session: next, changes: [], changesScope: 'all' });
  void refreshChanges();
  void refreshGit();
}

export function confirmRollback(checkpoint: number, label: string): void {
  setState({
    confirm: {
      title: 'Откатить изменения?',
      text: `Файлы вернутся к состоянию до хода «${label}», а этот ход и все после него исчезнут из истории. Правки, сделанные вручную после этого хода, в затронутых файлах пропадут.`,
      ok: 'Откатить',
      danger: true,
      run: () => void rollback(checkpoint),
    },
  });
}

export async function refreshChanges(scope: 'all' | number = getState().changesScope): Promise<void> {
  const s = getState().session;
  if (!s) return;
  const changes = await bridge.call('session.changes', { id: s.id, ...(scope === 'all' ? {} : { checkpoint: scope }) }).catch(() => undefined);
  if (changes) setState({ changes, changesScope: scope });
}

export async function refreshGit(): Promise<void> {
  if (!getState().project) return;
  const git = await bridge.call('git.status', {}).catch(() => null);
  setState({ git });
}

export function openFile(path: string): void {
  setState((s) => ({ openFiles: s.openFiles.includes(path) ? s.openFiles : [...s.openFiles, path], tab: `file:${path}`, panelOpen: true }));
}

export function closeFile(path: string): void {
  setState((s) => {
    const openFiles = s.openFiles.filter((p) => p !== path);
    const tab: RightTab = s.tab === `file:${path}` ? (openFiles.length ? `file:${openFiles[openFiles.length - 1]}` : 'files') : s.tab;
    return { openFiles, tab };
  });
}

export function showTab(tab: RightTab): void {
  setState({ tab, panelOpen: true });
  if (tab === 'changes') void refreshChanges();
}

export async function saveSettings(patch: Partial<Settings>): Promise<boolean> {
  try {
    const settings = await bridge.call('settings.set', patch);
    setState((s) => (s.info ? { info: { ...s.info, settings, configured: Boolean(settings.server.url || settings.server.modelFile || settings.server.hf) } } : {}));
    // сервис пересоздал агентов под новую модель: открываем текущую сессию заново
    const cur = getState().session;
    if (cur) {
      const session = await bridge.call('session.open', { id: cur.id });
      setState({ session });
    }
    return true;
  } catch (e) {
    toast(msg(e), 'error');
    return false;
  }
}
