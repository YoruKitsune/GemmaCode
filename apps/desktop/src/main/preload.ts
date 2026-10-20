import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gemmacode', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
});
