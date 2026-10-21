/**
 * Точка входа сервиса в utility-процессе Electron. Собирается отдельным файлом (esbuild) и запускается главным процессом.
 * Сообщения окна приходят через главный процесс по parentPort; корзину ОС может открыть только он, поэтому
 * `platform.trash` — обратный запрос к главному процессу.
 */
import type { PageFactory, PageHandle } from '@gemmacode/core';
import { AgentHost } from '../host.ts';
import { bindHost, isRequest } from './rpc.ts';

interface ParentPort {
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
  postMessage(m: unknown): void;
}
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parent) throw new Error('electron-entry запускается только как utility-процесс Electron');

const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
let seq = 0;

/** Запрос к главному процессу (корзина, страницы браузера): ответ приходит сообщением platformReply. */
function ask(payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    parent!.postMessage({ platform: { id, ...payload } });
  });
}

// События CDP страниц приходят из главного процесса; раздаём их подписчикам нужной страницы
const pageListeners = new Map<string, Set<(method: string, params: unknown) => void>>();

const electronPages: PageFactory = {
  async newPage(): Promise<PageHandle> {
    const id = (await ask({ op: 'browser.newPage' })) as string;
    const listeners = new Set<(method: string, params: unknown) => void>();
    pageListeners.set(id, listeners);
    return {
      id,
      send: (method, params) => ask({ op: 'browser.send', page: id, method, params }) as Promise<never>,
      onEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      close: async () => {
        pageListeners.delete(id);
        await ask({ op: 'browser.close', page: id });
      },
    };
  },
  async dispose() {
    pageListeners.clear();
    await ask({ op: 'browser.disposeAll' });
  },
};

const host = new AgentHost({
  version: process.env.GEMMACODE_VERSION ?? '0.0.0',
  watchFiles: true,
  platform: { trash: async (abs) => void (await ask({ op: 'trash', path: abs })) },
  browserFactory: async () => electronPages,
});

const bound = bindHost(host, (m) => parent.postMessage(m));
parent.on('message', (e) => {
  const m = e.data as { platformReply?: { id: number; error?: string; result?: unknown }; cdpEvent?: { page: string; method: string; params: unknown }; shutdown?: boolean };
  if (m && typeof m === 'object' && 'platformReply' in m && m.platformReply) {
    const w = waiting.get(m.platformReply.id);
    waiting.delete(m.platformReply.id);
    if (m.platformReply.error) w?.reject(new Error(m.platformReply.error));
    else w?.resolve(m.platformReply.result);
    return;
  }
  if (m && typeof m === 'object' && 'cdpEvent' in m && m.cdpEvent) {
    for (const l of pageListeners.get(m.cdpEvent.page) ?? []) l(m.cdpEvent.method, m.cdpEvent.params);
    return;
  }
  if (m && typeof m === 'object' && 'shutdown' in m) {
    void host.shutdown().finally(() => {
      parent.postMessage({ shutdownDone: true });
      process.exit(0);
    });
    return;
  }
  if (isRequest(e.data)) bound.handle(e.data);
});
parent.postMessage({ ready: true });
