/**
 * Точка входа сервиса в utility-процессе Electron. Собирается отдельным файлом (esbuild) и запускается главным процессом.
 * Сообщения окна приходят через главный процесс по parentPort; корзину ОС может открыть только он, поэтому
 * `platform.trash` — обратный запрос к главному процессу.
 */
import { AgentHost } from '../host.ts';
import { bindHost, isRequest } from './rpc.ts';

interface ParentPort {
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
  postMessage(m: unknown): void;
}
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parent) throw new Error('electron-entry запускается только как utility-процесс Electron');

const waiting = new Map<number, { resolve(): void; reject(e: Error): void }>();
let seq = 0;

const host = new AgentHost({
  version: process.env.GEMMACODE_VERSION ?? '0.0.0',
  watchFiles: true,
  platform: {
    trash: (abs) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        parent.postMessage({ platform: { id, op: 'trash', path: abs } });
      }),
  },
});

const bound = bindHost(host, (m) => parent.postMessage(m));
parent.on('message', (e) => {
  const m = e.data as { platformReply?: { id: number; error?: string }; shutdown?: boolean };
  if (m && typeof m === 'object' && 'platformReply' in m && m.platformReply) {
    const w = waiting.get(m.platformReply.id);
    waiting.delete(m.platformReply.id);
    if (m.platformReply.error) w?.reject(new Error(m.platformReply.error));
    else w?.resolve();
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
