import { app, BrowserWindow, ipcMain } from 'electron';
import { totalmem } from 'node:os';
import { join } from 'node:path';

// Контракт из src/shared/ipc.ts продублирован литералом: главный процесс собирается отдельно (CommonJS).
const APP_INFO_CHANNEL = 'app:info';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'GemmaCode',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.GEMMACODE_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

ipcMain.handle(APP_INFO_CHANNEL, () => ({
  version: app.getVersion(),
  platform: process.platform,
  totalMemGB: Math.round(totalmem() / 2 ** 30),
}));

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
