/**
 * Браузер агента сводится к двум интерфейсам: страница (`PageHandle`) и фабрика страниц (`PageFactory`).
 * Над ними работает `BrowserController` (CDP-команды, снимок страницы, права на домены), а откуда берутся страницы,
 * решает окружение: отдельный Chromium по отладочному порту (CLI, проверки, разработка) или страницы Electron через
 * `webContents.debugger` (приложение).
 */
export interface PageHandle {
  readonly id: string;
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** События CDP этой страницы. */
  onEvent(listener: (method: string, params: any) => void): () => void;
  close(): Promise<void>;
}

export interface PageFactory {
  newPage(): Promise<PageHandle>;
  dispose(): Promise<void>;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type BrowserEvent =
  | { type: 'state'; tabs: TabInfo[]; active: string | null }
  | { type: 'frame'; tab: string; data: string; width: number; height: number }
  | { type: 'blocked'; url: string; reason: string };

/** Ввод пользователя из окна браузера: координаты в пикселях страницы (CSS). */
export type BrowserInput =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right'; count?: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { kind: 'key'; key: string; code?: string; text?: string; modifiers?: number }
  | { kind: 'text'; text: string };
