import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forbiddenReason, isInside } from '../tools/paths.ts';
import { SNAPSHOT_SCRIPT } from './snapshot-script.ts';
import type { BrowserEvent, BrowserInput, PageFactory, PageHandle, TabInfo } from './types.ts';

export interface BrowserOptions {
  factory: PageFactory;
  /** Каталоги, файлы из которых можно открывать по file:// (корень проекта). */
  fileRoots: string[];
  viewport?: { width: number; height: number };
}

export interface SnapshotResult {
  title: string;
  url: string;
  scroll: string;
  lines: string[];
  refs: number;
  truncated: boolean;
}

const CONSOLE_LIMIT = 100;
const LOAD_TIMEOUT_MS = 20_000;

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32, text: ' ' },
};

const MODIFIERS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

class Tab {
  info: TabInfo;
  readonly page: PageHandle;
  readonly console: string[] = [];
  /** Сколько записей консоли уже отдано агенту. */
  consoleSeen = 0;
  inflight = 0;
  lastNetworkAt = Date.now();
  loadWaiters: Array<() => void> = [];
  unsubscribe: () => void = () => undefined;

  constructor(page: PageHandle) {
    this.page = page;
    this.info = { id: page.id, url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false };
  }

  log(line: string): void {
    this.console.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
    if (this.console.length > CONSOLE_LIMIT) {
      this.console.shift();
      this.consoleSeen = Math.max(0, this.consoleSeen - 1);
    }
  }
}

/**
 * Встроенный браузер: вкладки, переходы, снимок страницы для модели, клик и ввод по номеру элемента, консоль, снимки экрана
 * и ввод пользователя. Переходы документов проверяются здесь же: агент не может уйти по ссылке на домен, который никто не разрешил.
 */
export class BrowserController {
  private readonly factory: PageFactory;
  private readonly fileRoots: string[];
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private readonly allowedHosts = new Set<string>();
  private readonly listeners = new Set<(e: BrowserEvent) => void>();
  private viewport: { width: number; height: number };
  private viewers = 0;
  private stateTimer: NodeJS.Timeout | undefined;
  private creating: Promise<Tab> | undefined;
  private disposed = false;

  constructor(opts: BrowserOptions) {
    this.factory = opts.factory;
    this.fileRoots = opts.fileRoots.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return r;
      }
    });
    this.viewport = opts.viewport ?? { width: 1024, height: 768 };
  }

  // ---------- подписки и состояние ----------

  onEvent(l: (e: BrowserEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: BrowserEvent): void {
    for (const l of this.listeners) l(e);
  }

  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.emit({ type: 'state', tabs: this.tabList(), active: this.activeId });
    }, 40);
  }

  tabList(): TabInfo[] {
    return [...this.tabs.values()].map((t) => ({ ...t.info }));
  }

  get activeTab(): TabInfo | null {
    return this.activeId ? { ...this.tabs.get(this.activeId)!.info } : null;
  }

  // ---------- права на адреса ----------

  allowHost(host: string): void {
    this.allowedHosts.add(host.toLowerCase());
  }

  isLocalHost(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
  }

  /** Можно ли открыть адрес без вопроса: свои файлы проекта, локальный сервер, разрешённые домены. */
  isAllowed(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol === 'about:') return u.href === 'about:blank';
    if (u.protocol === 'file:') {
      try {
        const p = realpathSync(fileURLToPath(u));
        return this.fileRoots.some((r) => isInside(r, p)) && !forbiddenReason(p);
      } catch {
        return false;
      }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return this.isLocalHost(u.hostname) || this.allowedHosts.has(u.hostname.toLowerCase());
  }

  /** Страница из файлов проекта: её текст такой же «свой», как и файлы, прочитанные read_file. */
  isTrustedPage(): boolean {
    const url = this.activeTab?.url ?? '';
    return url.startsWith('file:') && this.isAllowed(url);
  }

  // ---------- вкладки ----------

  private async createTab(): Promise<Tab> {
    const page = await this.factory.newPage();
    const tab = new Tab(page);
    this.tabs.set(tab.info.id, tab);
    tab.unsubscribe = page.onEvent((method, params) => this.onPageEvent(tab, method, params));
    await Promise.all([page.send('Page.enable'), page.send('Runtime.enable'), page.send('Network.enable'), page.send('Log.enable')]);
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.open = (u) => { if (u) location.href = u; return null; };
        document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target]'); if (a && a.target !== '_self') a.target = '_self'; }, true);`,
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document' }] });
    await this.applyViewport(tab);
    if (!this.activeId) this.activeId = tab.info.id;
    if (this.activeId === tab.info.id && this.viewers > 0) await this.startScreencast(tab);
    this.scheduleState();
    return tab;
  }

  async newTab(url?: string): Promise<TabInfo> {
    this.assertLive();
    const tab = await this.createTab();
    await this.activate(tab.info.id);
    if (url) await this.navigate(url);
    return { ...tab.info };
  }

  async activate(id: string): Promise<void> {
    const next = this.tabs.get(id);
    if (!next) throw new Error('Вкладка не найдена');
    if (this.activeId === id) return;
    const prev = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (prev && this.viewers > 0) await this.stopScreencast(prev);
    this.activeId = id;
    if (this.viewers > 0) await this.startScreencast(next);
    this.scheduleState();
  }

  async closeTab(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.unsubscribe();
    this.tabs.delete(id);
    await tab.page.close().catch(() => undefined);
    if (this.activeId === id) {
      this.activeId = [...this.tabs.keys()].pop() ?? null;
      const next = this.activeId ? this.tabs.get(this.activeId) : undefined;
      if (next && this.viewers > 0) await this.startScreencast(next);
    }
    this.scheduleState();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Браузер закрыт');
  }

  private async current(): Promise<Tab> {
    this.assertLive();
    const t = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (t) return t;
    this.creating ??= this.createTab().finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  // ---------- события страницы ----------

  private onPageEvent(tab: Tab, method: string, p: any): void {
    switch (method) {
      case 'Page.frameStartedLoading':
        tab.info.loading = true;
        this.scheduleState();
        break;
      case 'Page.frameStoppedLoading':
        tab.info.loading = false;
        for (const w of tab.loadWaiters.splice(0)) w();
        void this.refreshInfo(tab);
        break;
      case 'Page.frameNavigated':
        if (!p.frame.parentId) {
          tab.info.url = p.frame.url;
          // file:// не проходит через Fetch, поэтому проверяем уже после перехода
          if (p.frame.url.startsWith('file:') && !this.isAllowed(p.frame.url)) {
            tab.log(`Blocked: ${p.frame.url} is outside the project.`);
            this.emit({ type: 'blocked', url: p.frame.url, reason: 'Файл вне проекта' });
            void tab.page.send('Page.navigate', { url: 'about:blank' }).catch(() => undefined);
          }
          this.scheduleState();
        }
        break;
      case 'Page.navigatedWithinDocument':
        tab.info.url = p.url;
        void this.refreshInfo(tab);
        break;
      case 'Page.javascriptDialogOpening':
        tab.log(`Dialog (${p.type}): ${p.message}`);
        void tab.page.send('Page.handleJavaScriptDialog', { accept: p.type !== 'beforeunload', promptText: p.defaultPrompt ?? '' }).catch(() => undefined);
        break;
      case 'Page.screencastFrame':
        if (this.activeId === tab.info.id) this.emit({ type: 'frame', tab: tab.info.id, data: p.data, width: p.metadata?.deviceWidth ?? this.viewport.width, height: p.metadata?.deviceHeight ?? this.viewport.height });
        void tab.page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
        break;
      case 'Runtime.consoleAPICalled': {
        const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
        tab.log(`console.${p.type}: ${text}`);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        const where = d.url ? ` (${d.url}:${(d.lineNumber ?? 0) + 1})` : '';
        tab.log(`Uncaught: ${d.exception?.description?.split('\n')[0] ?? d.text}${where}`);
        break;
      }
      case 'Log.entryAdded':
        if (p.entry.level === 'error' || p.entry.level === 'warning') tab.log(`${p.entry.level}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
        break;
      case 'Network.requestWillBeSent':
        tab.inflight++;
        tab.lastNetworkAt = Date.now();
        break;
      case 'Network.loadingFinished':
        tab.inflight = Math.max(0, tab.inflight - 1);
        tab.lastNetworkAt = Date.now();
        break;
      case 'Network.loadingFailed':
        tab.inflight = Math.max(0, tab.inflight - 1);
        tab.lastNetworkAt = Date.now();
        if (!p.canceled && p.errorText && !/ERR_ABORTED|BLOCKED_BY_CLIENT/.test(p.errorText)) tab.log(`Network error: ${p.errorText}${p.requestId ? '' : ''}`);
        break;
      case 'Network.responseReceived':
        if (p.response.status >= 400) tab.log(`HTTP ${p.response.status} ${p.response.url}`);
        break;
      case 'Fetch.requestPaused': {
        const url: string = p.request.url;
        if (this.isAllowed(url) || url.startsWith('chrome-error:')) void tab.page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
        else {
          tab.log(`Blocked navigation to ${url}: the site is not allowed. Use action "open" with this URL to ask the user.`);
          this.emit({ type: 'blocked', url, reason: 'Сайт не разрешён' });
          // 204 на запрос документа не меняет страницу: пользователь остаётся там, где был, а не на странице ошибки
          void tab.page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: [] }).catch(() => undefined);
        }
        break;
      }
      case 'Inspector.targetCrashed':
        tab.log('The page crashed.');
        break;
    }
  }

  private async refreshInfo(tab: Tab): Promise<void> {
    try {
      const v = await this.evalValue<[string, string]>(tab, '[document.title, location.href]');
      tab.info.title = v[0];
      tab.info.url = v[1];
      const h = await tab.page.send<{ currentIndex: number; entries: unknown[] }>('Page.getNavigationHistory');
      tab.info.canGoBack = h.currentIndex > 0;
      tab.info.canGoForward = h.currentIndex < h.entries.length - 1;
    } catch {
      // страница закрыта или ещё не готова
    }
    this.scheduleState();
  }

  private async evalValue<T>(tab: Tab, expression: string): Promise<T> {
    const r = await tab.page.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  // ---------- переходы ----------

  private waitLoaded(tab: Tab, timeoutMs = LOAD_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      tab.loadWaiters.push(() => finish(true));
    });
  }

  /** Ждём, пока страница перестанет грузиться и сеть утихнет: после клика данные часто догружаются. */
  private async settle(tab: Tab, maxMs = 5000, quietMs = 300): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (!tab.info.loading && tab.inflight === 0 && Date.now() - tab.lastNetworkAt >= quietMs) return;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  async navigate(url: string): Promise<{ ok: boolean; error?: string }> {
    const tab = await this.current();
    if (!this.isAllowed(url)) return { ok: false, error: 'The site is not allowed. Ask the user to allow it.' };
    const loaded = this.waitLoaded(tab);
    const r = await tab.page.send<{ errorText?: string }>('Page.navigate', { url });
    if (r.errorText) {
      tab.loadWaiters.length = 0;
      const blocked = /BLOCKED_BY_CLIENT/.test(r.errorText);
      return { ok: false, error: blocked ? 'The site is not allowed. Ask the user to allow it.' : `Could not load the page: ${r.errorText}` };
    }
    const done = await loaded;
    await this.settle(tab);
    await this.refreshInfo(tab);
    return done ? { ok: true } : { ok: true, error: 'The page is still loading; showing what is there.' };
  }

  async history(delta: -1 | 1): Promise<{ ok: boolean; error?: string }> {
    const tab = await this.current();
    const h = await tab.page.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    const entry = h.entries[h.currentIndex + delta];
    if (!entry) return { ok: false, error: delta < 0 ? 'No page to go back to.' : 'No page to go forward to.' };
    const loaded = this.waitLoaded(tab, 10_000);
    await tab.page.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    await loaded;
    await this.settle(tab);
    await this.refreshInfo(tab);
    return { ok: true };
  }

  async reload(): Promise<void> {
    const tab = await this.current();
    const loaded = this.waitLoaded(tab);
    await tab.page.send('Page.reload', { ignoreCache: true });
    await loaded;
    await this.settle(tab);
    await this.refreshInfo(tab);
  }

  async stop(): Promise<void> {
    const tab = await this.current();
    await tab.page.send('Page.stopLoading').catch(() => undefined);
  }

  // ---------- чтение страницы ----------

  async snapshot(): Promise<SnapshotResult> {
    const tab = await this.current();
    const raw = await this.evalValue<string>(tab, SNAPSHOT_SCRIPT);
    return JSON.parse(raw) as SnapshotResult;
  }

  /** Текст снимка с номерами строк для постраничного чтения: `offset` — сколько строк пропустить. */
  async snapshotText(offset = 0, maxChars = 4500): Promise<string> {
    const s = await this.snapshot();
    const tab = this.tabs.get(this.activeId!)!;
    const head = [`Page: ${s.title || '(no title)'}`, `URL: ${s.url}`, `Scroll: ${s.scroll}`];
    const unseen = tab.console.length - tab.consoleSeen;
    if (unseen > 0) head.push(`Console: ${unseen} new message(s), read them with action "console".`);
    const body: string[] = [];
    let used = head.join('\n').length;
    let i = offset;
    for (; i < s.lines.length; i++) {
      const l = s.lines[i]!;
      if (used + l.length + 1 > maxChars && body.length > 0) break;
      body.push(l);
      used += l.length + 1;
    }
    const out = [...head, '', ...(body.length ? body : ['(the page has no visible text or controls)'])];
    if (i < s.lines.length) out.push(`… ${s.lines.length - i} more lines. Call snapshot with offset=${i} to continue.`);
    if (s.truncated) out.push('(the page is very large: only the beginning was read)');
    return out.join('\n');
  }

  /** Новые записи консоли и сетевые ошибки с прошлого вызова. */
  async consoleLines(): Promise<string[]> {
    const tab = await this.current();
    const fresh = tab.console.slice(tab.consoleSeen);
    tab.consoleSeen = tab.console.length;
    return fresh;
  }

  async screenshot(): Promise<{ data: Buffer; mime: string; width: number; height: number }> {
    const tab = await this.current();
    await this.settle(tab, 2000, 200);
    const r = await tab.page.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
    return { data: Buffer.from(r.data, 'base64'), mime: 'image/jpeg', width: this.viewport.width, height: this.viewport.height };
  }

  // ---------- действия ----------

  private async elementCenter(tab: Tab, ref: number): Promise<{ objectId: string; x: number; y: number; covered: boolean }> {
    const found = await tab.page.send<{ result: { objectId?: string; subtype?: string } }>('Runtime.evaluate', { expression: `(window.__gcRefs || [])[${Math.trunc(ref) - 1}]` });
    const objectId = found.result.objectId;
    if (!objectId || found.result.subtype === 'null') throw new Error(`Element [${ref}] is not on the page. Take a new snapshot: numbers change after the page changes.`);
    const r = await tab.page.send<{ result: { value?: { x: number; y: number; covered: boolean; w: number; h: number } }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        if (!this.isConnected) return null;
        this.scrollIntoView({ block: 'center', inline: 'center' });
        const r = this.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return { x, y, w: r.width, h: r.height, covered: !(top && (top === this || this.contains(top) || top.contains(this))) };
      }`,
    });
    const v = r.result.value;
    if (!v) throw new Error(`Element [${ref}] is no longer on the page. Take a new snapshot.`);
    return { objectId, x: v.x, y: v.y, covered: v.covered || v.w === 0 || v.h === 0 };
  }

  async click(ref: number): Promise<void> {
    const tab = await this.current();
    const el = await this.elementCenter(tab, ref);
    if (el.covered) {
      // элемент перекрыт или без размера: честный клик не дойдёт, вызываем click() у самого элемента
      await tab.page.send('Runtime.callFunctionOn', { objectId: el.objectId, functionDeclaration: 'function () { this.click(); }' });
    } else {
      await this.mouseClick(tab, el.x, el.y);
    }
    await new Promise((r) => setTimeout(r, 120));
    await this.settle(tab);
    await this.refreshInfo(tab);
  }

  private async mouseClick(tab: Tab, x: number, y: number, button: 'left' | 'right' = 'left', count = 1): Promise<void> {
    await tab.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await tab.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: count });
    await tab.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: count });
  }

  async type(ref: number, text: string, submit = false): Promise<void> {
    const tab = await this.current();
    const el = await this.elementCenter(tab, ref);
    const kind = await tab.page.send<{ result: { value?: string } }>('Runtime.callFunctionOn', {
      objectId: el.objectId,
      returnByValue: true,
      functionDeclaration: `function (text) {
        const tag = this.tagName;
        if (tag === 'SELECT') {
          const want = String(text).trim().toLowerCase();
          const opt = [...this.options].find((o) => o.value.toLowerCase() === want || o.textContent.trim().toLowerCase() === want);
          if (!opt) return 'no-option';
          this.value = opt.value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return 'select';
        }
        this.focus();
        if (typeof this.select === 'function' && (tag === 'INPUT' || tag === 'TEXTAREA')) this.select();
        else if (this.isContentEditable) document.execCommand('selectAll');
        return 'text';
      }`,
      arguments: [{ value: text }],
    });
    if (kind.result.value === 'no-option') throw new Error(`Element [${ref}] has no option "${text}". Use one of the options from the snapshot.`);
    if (kind.result.value === 'text') {
      if (text === '') await this.pressKey(tab, 'Backspace');
      else await tab.page.send('Input.insertText', { text });
    }
    if (submit) await this.pressKey(tab, 'Enter');
    await new Promise((r) => setTimeout(r, 120));
    await this.settle(tab);
    await this.refreshInfo(tab);
  }

  async press(key: string): Promise<void> {
    const tab = await this.current();
    await this.pressKey(tab, key);
    await new Promise((r) => setTimeout(r, 120));
    await this.settle(tab);
    await this.refreshInfo(tab);
  }

  private async pressKey(tab: Tab, spec: string): Promise<void> {
    const parts = spec.split('+').map((s) => s.trim()).filter(Boolean);
    const key = parts.pop() ?? '';
    let modifiers = 0;
    for (const m of parts) modifiers |= MODIFIERS[m.toLowerCase()] ?? 0;
    const known = KEYS[key] ?? KEYS[key.charAt(0).toUpperCase() + key.slice(1)];
    const down: Record<string, unknown> = { type: 'keyDown', modifiers, key: known ? (key === 'Space' ? ' ' : (Object.keys(KEYS).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key)) : key };
    if (known) {
      down.code = known.code;
      down.windowsVirtualKeyCode = known.vk;
      if (known.text && !(modifiers & 6)) down.text = known.text;
    } else if (key.length === 1) {
      down.code = /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : undefined;
      down.windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0);
      if (!(modifiers & 6)) down.text = key;
    }
    await tab.page.send('Input.dispatchKeyEvent', down);
    await tab.page.send('Input.dispatchKeyEvent', { ...down, type: 'keyUp', text: undefined });
  }

  async scroll(direction: 'down' | 'up' | 'top' | 'bottom'): Promise<string> {
    const tab = await this.current();
    const expr = {
      down: 'window.scrollBy(0, Math.round(window.innerHeight * 0.8))',
      up: 'window.scrollBy(0, -Math.round(window.innerHeight * 0.8))',
      top: 'window.scrollTo(0, 0)',
      bottom: 'window.scrollTo(0, document.documentElement.scrollHeight)',
    }[direction];
    await this.evalValue(tab, `${expr}; 0`);
    await new Promise((r) => setTimeout(r, 150));
    return this.evalValue<string>(tab, '`scrollY ${Math.round(window.scrollY)} of ${Math.max(0, document.documentElement.scrollHeight - window.innerHeight)}`');
  }

  /** Ждём появления текста на странице или просто паузу. Возвращает true, если текст найден. */
  async waitFor(text: string | undefined, seconds: number): Promise<boolean> {
    const tab = await this.current();
    const until = Date.now() + Math.min(Math.max(seconds, 0.2), 20) * 1000;
    if (!text) {
      await new Promise((r) => setTimeout(r, until - Date.now()));
      await this.settle(tab, 2000);
      return true;
    }
    while (Date.now() < until) {
      const found = await this.evalValue<boolean>(tab, `(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`);
      if (found) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  // ---------- окно пользователя ----------

  /** Ввод пользователя из окна: клик, колесо, клавиши и вставка текста уходят в активную вкладку. */
  async input(ev: BrowserInput): Promise<void> {
    const tab = await this.current();
    switch (ev.kind) {
      case 'click':
        await this.mouseClick(tab, ev.x, ev.y, ev.button ?? 'left', ev.count ?? 1);
        break;
      case 'move':
        await tab.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ev.x, y: ev.y });
        break;
      case 'wheel':
        await tab.page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy });
        break;
      case 'key': {
        const base: Record<string, unknown> = { key: ev.key, modifiers: ev.modifiers ?? 0, ...(ev.code ? { code: ev.code } : {}) };
        const known = KEYS[ev.key];
        if (known) base.windowsVirtualKeyCode = known.vk;
        const text = ev.text ?? (ev.key.length === 1 ? ev.key : known?.text);
        await tab.page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text && !((ev.modifiers ?? 0) & 6) ? { text } : {}) });
        await tab.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        break;
      }
      case 'text':
        await tab.page.send('Input.insertText', { text: ev.text });
        break;
    }
  }

  async setViewport(width: number, height: number): Promise<void> {
    const w = Math.round(Math.min(Math.max(width, 320), 2400));
    const h = Math.round(Math.min(Math.max(height, 240), 1800));
    if (w === this.viewport.width && h === this.viewport.height) return;
    this.viewport = { width: w, height: h };
    for (const t of this.tabs.values()) await this.applyViewport(t);
    const active = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (active && this.viewers > 0) {
      await this.stopScreencast(active);
      await this.startScreencast(active);
    }
  }

  private applyViewport(tab: Tab): Promise<unknown> {
    return tab.page.send('Emulation.setDeviceMetricsOverride', { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
  }

  /** Окно показывает браузер: пока есть зрители, активная вкладка шлёт кадры. */
  async attachViewer(): Promise<void> {
    this.viewers++;
    if (this.viewers === 1) {
      const t = await this.current();
      await this.startScreencast(t);
    }
  }

  async detachViewer(): Promise<void> {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0 && this.activeId) {
      const t = this.tabs.get(this.activeId);
      if (t) await this.stopScreencast(t);
    }
  }

  private startScreencast(tab: Tab): Promise<unknown> {
    return tab.page.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 }).catch(() => undefined);
  }

  private stopScreencast(tab: Tab): Promise<unknown> {
    return tab.page.send('Page.stopScreencast').catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.stateTimer);
    for (const t of this.tabs.values()) {
      t.unsubscribe();
      await t.page.close().catch(() => undefined);
    }
    this.tabs.clear();
    this.activeId = null;
    await this.factory.dispose().catch(() => undefined);
  }
}
