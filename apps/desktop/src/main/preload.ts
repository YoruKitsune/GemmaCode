import { contextBridge, ipcRenderer } from 'electron';

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
ipcRenderer.on('host:event', (_e, msg: { event: string; data: unknown }) => {
  for (const l of listeners) l(msg.event, msg.data);
});

// Единственная поверхность между окном и остальной системой: вызовы сервиса агента, события и системные диалоги.
contextBridge.exposeInMainWorld('gemmacode', {
  call: (method: string, params: unknown) => ipcRenderer.invoke('host:call', method, params),
  onEvent: (cb: Listener) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  pickPath: (opts: { kind: 'folder' | 'file'; title?: string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke('dialog:pick', opts),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  revealInFolder: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  platform: process.platform,
});
