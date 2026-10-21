import { useSyncExternalStore } from 'react';
import type {
  AppInfo,
  ApprovalRequestWire,
  BackendStatus,
  BrowserState,
  CommandInfo,
  FileChange,
  GitStatus,
  ProjectState,
  SessionState,
  SessionSummary,
} from '@gemmacode/protocol';

export type RightTab = 'files' | 'changes' | 'terminal' | 'browser' | 'stats' | `file:${string}`;

export interface Toast {
  id: number;
  level: 'info' | 'error';
  text: string;
}

export interface State {
  booted: boolean;
  info: AppInfo | null;
  project: ProjectState | null;
  sessions: SessionSummary[];
  session: SessionState | null;
  backend: { status: BackendStatus; message?: string; model?: string };
  approvals: ApprovalRequestWire[];
  commands: CommandInfo[];
  /** Скорость последнего шага, ток/с. */
  speed: number;
  panelOpen: boolean;
  panelWidth: number;
  tab: RightTab;
  openFiles: string[];
  git: GitStatus | null;
  /** Увеличивается при каждом изменении файлов; окна дерева и вкладок перечитывают данные. */
  fsVersion: number;
  fsPaths: string[];
  /** Вкладки встроенного браузера (кадры идут отдельной шиной: их десятки в секунду). */
  browser: BrowserState | null;
  /** Изменения сессии для вкладки «Изменения» и бейджа. */
  changes: FileChange[];
  changesScope: 'all' | number;
  settingsOpen: boolean;
  quickOpen: boolean;
  confirm: { title: string; text: string; ok: string; danger?: boolean; run(): void } | null;
  prompt: { title: string; value: string; ok: string; hint?: string; run(value: string): void } | null;
  toasts: Toast[];
}

const PANEL_KEY = 'gemmacode.panel';

function loadPanel(): { open: boolean; width: number } {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}') as { open?: boolean; width?: number };
    return { open: v.open ?? true, width: Math.min(900, Math.max(320, v.width ?? 480)) };
  } catch {
    return { open: true, width: 480 };
  }
}

const panel = loadPanel();

let state: State = {
  booted: false,
  info: null,
  project: null,
  sessions: [],
  session: null,
  backend: { status: 'stopped' },
  approvals: [],
  commands: [],
  speed: 0,
  panelOpen: panel.open,
  panelWidth: panel.width,
  tab: 'files',
  openFiles: [],
  git: null,
  fsVersion: 0,
  fsPaths: [],
  browser: null,
  changes: [],
  changesScope: 'all',
  settingsOpen: false,
  quickOpen: false,
  confirm: null,
  prompt: null,
  toasts: [],
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if ('panelOpen' in p || 'panelWidth' in p) {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify({ open: state.panelOpen, width: state.panelWidth }));
    } catch {
      // хранилище недоступно — настройка панели не запомнится
    }
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

let toastId = 0;
export function toast(text: string, level: Toast['level'] = 'info'): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, level, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 9000 : 4000);
}
