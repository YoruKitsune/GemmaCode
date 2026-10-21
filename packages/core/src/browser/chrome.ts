import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageFactory, PageHandle } from './types.ts';

/** Где искать Chromium-совместимый браузер, если путь не задан: переменная окружения, типичные места ОС, сборки Playwright. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`, join(homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', app));
    }
  } else if (process.platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (base) candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else {
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) candidates.push(p);
  }
  const pw = env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(pw)) {
    for (const d of readdirSync(pw).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']) candidates.push(join(pw, d, sub));
    }
  }
  return candidates.find((c) => existsSync(c));
}

interface Pending {
  resolve(v: any): void;
  reject(e: Error): void;
}

type Listener = (method: string, params: any) => void;

/** Минимальный клиент CDP по WebSocket: команды с ответами, события по sessionId. */
class CdpConnection {
  private readonly ws: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, Set<Listener>>();
  private onClose: () => void = () => undefined;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const l of this.sessions.get(m.sessionId ?? '') ?? []) l(m.method, m.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Браузер закрыт'));
      this.pending.clear();
      this.onClose();
    });
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CdpConnection(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error('Не удалось подключиться к отладочному порту браузера')), { once: true });
    });
  }

  closed(cb: () => void): void {
    this.onClose = cb;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  subscribe(sessionId: string, l: Listener): () => void {
    let set = this.sessions.get(sessionId);
    if (!set) this.sessions.set(sessionId, (set = new Set()));
    set.add(l);
    return () => set!.delete(l);
  }

  close(): void {
    this.ws.close();
  }
}

export interface ChromeOptions {
  executablePath?: string;
  /** Показывать окно браузера (для отладки). По умолчанию безголовый режим. */
  headed?: boolean;
  /** Дополнительные флаги Chromium. */
  args?: string[];
}

/**
 * Свой Chromium под управлением агента: отдельный временный профиль, без расширений и без входов пользователя
 * в сайты. Страницы создаются через Target.createTarget. Используется там, где нет Electron: CLI, проверки, разработка.
 */
export class ChromeFactory implements PageFactory {
  private readonly proc: ChildProcess;
  private readonly conn: CdpConnection;
  private readonly profile: string;
  private disposed = false;

  private constructor(proc: ChildProcess, conn: CdpConnection, profile: string) {
    this.proc = proc;
    this.conn = conn;
    this.profile = profile;
    conn.closed(() => void this.dispose());
  }

  static async launch(opts: ChromeOptions = {}): Promise<ChromeFactory> {
    const exe = opts.executablePath ?? findChrome();
    if (!exe) throw new Error('Не найден Chrome или Chromium. Укажите путь в настройках браузера или переменной CHROME_PATH.');
    const profile = mkdtempSync(join(tmpdir(), 'gemmacode-chrome-'));
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--mute-audio',
      '--hide-scrollbars',
      ...(opts.headed ? [] : ['--headless=new']),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      ...(opts.args ?? []),
      'about:blank',
    ];
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error(`Браузер не ответил за 15 с. ${log.slice(-300)}`)), 15_000);
      proc.stderr!.on('data', (d: Buffer) => {
        log += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Не удалось запустить браузер ${exe}: ${e.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Браузер завершился при запуске (код ${code}). ${log.slice(-300)}`));
      });
    }).catch((e) => {
      proc.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true });
      throw e;
    });
    const conn = await CdpConnection.connect(wsUrl);
    // Скачивание файлов из страницы агента не нужно и небезопасно
    await conn.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
    return new ChromeFactory(proc, conn, profile);
  }

  async newPage(): Promise<PageHandle> {
    const { targetId } = await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const conn = this.conn;
    return {
      id: targetId,
      send: (method, params) => conn.send(method, params, sessionId),
      onEvent: (l) => conn.subscribe(sessionId, l),
      close: async () => {
        await conn.send('Target.closeTarget', { targetId }).catch(() => undefined);
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.conn.send('Browser.close').catch(() => undefined);
      this.conn.close();
    } catch {
      // уже закрыт
    }
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 2000);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
