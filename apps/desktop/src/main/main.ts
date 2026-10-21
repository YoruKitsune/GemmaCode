import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, utilityProcess, type UtilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Окно (renderer) и сервис агента (utility-процесс) не знают друг о друге: главный процесс только пересылает сообщения,
// открывает системные диалоги и корзину. Любое действие на хосте идёт через сервис и слой прав ядра.

let win: BrowserWindow | null = null;
let host: UtilityProcess | null = null;
let hostReady: Promise<void> | null = null;
let seq = 0;
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

/** Закреплённая сборка llama-server: в установщике она в ресурсах, в режиме разработки в `apps/desktop/resources` (после `npm run fetch:llama`). */
function bundledLlamaEnv(): Record<string, string> {
  const dir = app.isPackaged ? join(process.resourcesPath, 'llama') : join(__dirname, '../../resources/llama');
  return existsSync(dir) ? { GEMMACODE_LLAMA_DIR: dir } : {};
}

function startHost(): void {
  host = utilityProcess.fork(join(__dirname, '../host/host.cjs'), [], {
    serviceName: 'GemmaCode agent',
    stdio: 'inherit',
    env: { ...process.env, GEMMACODE_VERSION: app.getVersion(), ...bundledLlamaEnv() },
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

// ---------- страницы встроенного браузера ----------
// Страницы агента живут в скрытых окнах с отдельным профилем (без cookies и входов пользователя в сайты). Сервис управляет
// ими по CDP через webContents.debugger: главный процесс только создаёт страницу и пересылает команды и события.

const AGENT_PARTITION = 'gemmacode-agent-browser';
const agentPages = new Map<string, BrowserWindow>();
let pageSeq = 0;
let agentSessionReady = false;

function prepareAgentSession(): void {
  if (agentSessionReady) return;
  agentSessionReady = true;
  const ses = session.fromPartition(AGENT_PARTITION);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
}

async function newAgentPage(): Promise<string> {
  prepareAgentSession();
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    frame: false,
    webPreferences: { partition: AGENT_PARTITION, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const id = `page${++pageSeq}`;
  const wc = win.webContents;
  wc.setFrameRate(30);
  wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sgemmacode\S*/i, ''));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // пока в окне нет страницы, процесса отрисовки нет и отладчику не к чему подключаться
  await wc.loadURL('about:blank');
  wc.debugger.attach('1.3');
  wc.debugger.on('message', (_e, method, params) => host?.postMessage({ cdpEvent: { page: id, method, params } }));
  agentPages.set(id, win);
  win.on('closed', () => agentPages.delete(id));
  return id;
}

async function handlePlatform(req: { id: number; op: string; path?: string; page?: string; method?: string; params?: Record<string, unknown> }): Promise<void> {
  try {
    let result: unknown;
    if (req.op === 'trash') await shell.trashItem(req.path!);
    else if (req.op === 'browser.newPage') result = await newAgentPage();
    else if (req.op === 'browser.send') {
      const win = agentPages.get(req.page!);
      if (!win || win.isDestroyed()) throw new Error('Страница закрыта');
      result = await win.webContents.debugger.sendCommand(req.method!, req.params ?? {});
    } else if (req.op === 'browser.close') {
      const win = agentPages.get(req.page!);
      agentPages.delete(req.page!);
      if (win && !win.isDestroyed()) win.destroy();
    } else if (req.op === 'browser.disposeAll') {
      for (const w of agentPages.values()) if (!w.isDestroyed()) w.destroy();
      agentPages.clear();
    }
    host?.postMessage({ platformReply: { id: req.id, result } });
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
    // скрытые окна страниц агента не должны удерживать приложение после закрытия главного окна
    app.quit();
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
