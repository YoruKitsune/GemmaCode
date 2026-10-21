import type { MethodName, Methods, WireMessage } from '@gemmacode/protocol';

export type EventListener = (event: string, data: any) => void;

export interface PickOptions {
  kind: 'folder' | 'file';
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** Всё, что окно умеет делать с внешним миром. В приложении это IPC Electron, в проверках — WebSocket к настоящему сервису. */
export interface Bridge {
  call<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']>;
  onEvent(cb: EventListener): () => void;
  pickPath(opts: PickOptions): Promise<string | null>;
  openExternal(url: string): void;
  platform: string;
  kind: 'electron' | 'web';
}

declare global {
  interface Window {
    gemmacode?: {
      call(method: string, params: unknown): Promise<unknown>;
      onEvent(cb: EventListener): () => void;
      pickPath(opts: PickOptions): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      platform: string;
    };
  }
}

function electronBridge(api: NonNullable<Window['gemmacode']>): Bridge {
  return {
    call: (method, params) => api.call(method, params) as Promise<never>,
    onEvent: (cb) => api.onEvent(cb),
    pickPath: (o) => api.pickPath(o),
    openExternal: (url) => void api.openExternal(url),
    platform: api.platform,
    kind: 'electron',
  };
}

function webSocketBridge(port: string): Bridge {
  const listeners = new Set<EventListener>();
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let seq = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Нет соединения с сервисом агента'));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as WireMessage;
    if ('event' in m) {
      for (const l of listeners) l(m.event, m.data);
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if ('error' in m) w.reject(new Error(m.error.message));
    else w.resolve(m.result);
  };
  return {
    async call(method, params) {
      await opened;
      return new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    pickPath: async () => null,
    openExternal: (url) => void window.open(url, '_blank', 'noopener'),
    platform: 'web',
    kind: 'web',
  };
}

export function createBridge(): Bridge {
  if (window.gemmacode) return electronBridge(window.gemmacode);
  const port = new URLSearchParams(location.search).get('ws');
  if (!port) throw new Error('Нет моста к сервису агента: откройте приложение через Electron или добавьте ?ws=ПОРТ');
  return webSocketBridge(port);
}

export const bridge: Bridge = createBridge();
