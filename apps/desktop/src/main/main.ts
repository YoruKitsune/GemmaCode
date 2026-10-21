import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';

// Окно (renderer) и сервис агента (utility-процесс) не знают друг о друге: главный процесс только пересылает сообщения,
// открывает системные диалоги и корзину. Любое действие на хосте идёт через сервис и слой прав ядра.

let win: BrowserWindow | null = null;
let host: UtilityProcess | null = null;
let hostReady: Promise<void> | null = null;
let seq = 0;
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

function startHost(): void {
  host = utilityProcess.fork(join(__dirname, '../host/host.cjs'), [], {
    serviceName: 'GemmaCode agent',
    stdio: 'inherit',
    env: { ...process.env, GEMMACODE_VERSION: app.getVersion() },
  });
  hostReady = new Promise((resolve) => {
    host!.on('message', (m: any) => {
      if (m?.ready) return resolve();
      if (m?.platform) return void handlePlatform(m.platform);
      if (m && typeof m === 'object' && 'id' in m) {
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        if ('error' in m) w.reject(new Error(m.error.message));
        else w.resolve(m.result);
        return;
      }
      if (m && typeof m === 'object' && 'event' in m) win?.webContents.send('host:event', m);
    });
  });
  host.on('exit', (code) => {
    host = null;
    for (const w of waiting.values()) w.reject(new Error(`Сервис агента завершился (код ${code})`));
    waiting.clear();
    win?.webContents.send('host:event', { event: 'host.crashed', data: { code } });
  });
}

async function handlePlatform(req: { id: number; op: string; path: string }): Promise<void> {
  try {
    if (req.op === 'trash') await shell.trashItem(req.path);
    host?.postMessage({ platformReply: { id: req.id } });
  } catch (e) {
    host?.postMessage({ platformReply: { id: req.id, error: (e as Error).message } });
  }
}

async function callHost(method: string, params: unknown): Promise<unknown> {
  if (!host) startHost();
  await hostReady;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    host!.postMessage({ id, method, params });
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'GemmaCode',
    backgroundColor: '#16181d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  const devUrl = process.env.GEMMACODE_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function openExternalSafe(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url);
  } catch {
    // не URL
  }
}

ipcMain.handle('host:call', (_e, method: string, params: unknown) => callHost(method, params));
ipcMain.handle('dialog:pick', async (_e, opts: { kind: 'folder' | 'file'; title?: string; filters?: { name: string; extensions: string[] }[] }) => {
  const r = await dialog.showOpenDialog(win!, {
    title: opts.title,
    properties: opts.kind === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile'],
    ...(opts.filters ? { filters: opts.filters } : {}),
  });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle('shell:openExternal', (_e, url: string) => openExternalSafe(url));
ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path));

function buildMenu(): void {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: 'appMenu' as const }] : []),
      { label: 'Файл', submenu: [{ label: 'Открыть проект…', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.send('host:event', { event: 'ui.command', data: { command: 'open-project' } }) }, mac ? { role: 'close' as const } : { role: 'quit' as const }] },
      { role: 'editMenu' as const },
      { label: 'Вид', submenu: [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }, { role: 'resetZoom' as const }, { role: 'zoomIn' as const }, { role: 'zoomOut' as const }, { role: 'togglefullscreen' as const }] },
      { role: 'windowMenu' as const },
    ]),
  );
}

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !host) return;
  // Даём сервису остановить llama-server и закрыть терминалы: иначе модель останется в памяти без окна.
  e.preventDefault();
  quitting = true;
  const h = host;
  const done = () => app.quit();
  h.on('message', (m: any) => m?.shutdownDone && done());
  h.on('exit', done);
  h.postMessage({ shutdown: true });
  setTimeout(() => {
    h.kill();
    done();
  }, 6000).unref();
});

void app.whenReady().then(() => {
  buildMenu();
  startHost();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
