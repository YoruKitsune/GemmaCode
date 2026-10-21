import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { resolveUserPath } from './paths.ts';

type Action = 'open' | 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'back' | 'reload' | 'console' | 'screenshot' | 'wait';

export interface BrowserArgs {
  action: Action;
  url?: string;
  ref?: number;
  text?: string;
  submit?: boolean;
  key?: string;
  direction?: string;
  offset?: number;
  seconds?: number;
}

const ACTIONS: Action[] = ['open', 'snapshot', 'click', 'type', 'press', 'scroll', 'back', 'reload', 'console', 'screenshot', 'wait'];

/**
 * Адрес из аргумента модели: полный URL, локальный сервер без схемы (localhost:3000), путь к файлу проекта (index.html)
 * или домен. Всё остальное (javascript:, data:, chrome:) отклоняется.
 */
export function resolveBrowserUrl(input: string, cwd: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') return u.href;
      return s === 'about:blank' ? s : null;
    } catch {
      return null;
    }
  }
  const abs = resolveUserPath(cwd, s);
  if (existsSync(abs)) return pathToFileURL(abs).href;
  if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(s)) return `https://${s}`;
  return null;
}

const DESCRIPTION =
  'Control the built-in web browser. open: go to url (a web address, localhost:3000, or a project file like index.html). ' +
  'snapshot: read the page as text; interactive elements are numbered [n]. click: click element ref=n. ' +
  'type: put text into element ref=n (submit=true presses Enter). press: send a key such as Enter, Tab, Escape. scroll: direction down or up. ' +
  'console: JavaScript errors and failed requests since the last check. screenshot: see the page as an image. wait: wait for text or seconds. back, reload.';

export const browserTool: Tool<BrowserArgs> = {
  name: 'browser',
  description: DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: ACTIONS.join(', '), enum: ACTIONS },
      url: { type: 'string', description: 'For open: address or project file path' },
      ref: { type: 'integer', description: 'For click and type: element number [n] from the latest snapshot' },
      text: { type: 'string', description: 'For type: text to enter. For wait: text to wait for' },
      submit: { type: 'boolean', description: 'For type: press Enter afterwards' },
      key: { type: 'string', description: 'For press: Enter, Tab, Escape, ArrowDown, a letter, or a combination like Control+a' },
      direction: { type: 'string', description: 'For scroll: down, up, top or bottom' },
      offset: { type: 'integer', description: 'For snapshot: skip this many lines (to read a long page further)' },
      seconds: { type: 'number', description: 'For wait: how long, default 5' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  risk: 'browser',
  inspect(a, ctx) {
    switch (a.action) {
      case 'open': {
        const url = a.url ? resolveBrowserUrl(a.url, ctx.cwd) : null;
        const filePath = url?.startsWith('file:') ? fileURLToPath(url) : undefined;
        return { summary: `browser open ${url ?? a.url ?? ''}`.trim(), ...(url ? { url } : {}), ...(filePath ? { paths: [filePath] } : {}) };
      }
      case 'click':
        return { summary: `browser click [${a.ref ?? '?'}]` };
      case 'type':
        return { summary: `browser type [${a.ref ?? '?'}] "${(a.text ?? '').slice(0, 40)}"${a.submit ? ' + Enter' : ''}` };
      case 'press':
        return { summary: `browser press ${a.key ?? ''}` };
      default:
        return { summary: `browser ${a.action}` };
    }
  },
  async run(a, ctx): Promise<ToolResult> {
    const b = ctx.browser;
    if (!b) return { content: 'The browser is not available in this session.', isError: true };
    try {
      return await runAction(a, ctx);
    } catch (e) {
      return { content: `Browser error: ${(e as Error).message}`, isError: true };
    }
  },
};

async function page(ctx: ToolContext, lead: string, offset = 0): Promise<ToolResult> {
  const b = ctx.browser!;
  const text = await b.snapshotText(offset);
  return { content: lead ? `${lead}\n\n${text}` : text, untrusted: !b.isTrustedPage() };
}

async function runAction(a: BrowserArgs, ctx: ToolContext): Promise<ToolResult> {
  const b = ctx.browser!;
  const needRef = (): number => {
    if (a.ref === undefined) throw new Error(`Action ${a.action} needs ref: the element number [n] from the latest snapshot.`);
    return a.ref;
  };
  switch (a.action) {
    case 'open': {
      if (!a.url) throw new Error('Action open needs url.');
      const url = resolveBrowserUrl(a.url, ctx.cwd);
      if (!url) throw new Error(`"${a.url}" is not an address I can open. Use http(s)://…, localhost:PORT or a project file path.`);
      // решение о доступе уже принято политикой прав; домен запоминается, чтобы переходы по ссылкам на нём не блокировались
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') b.allowHost(u.hostname);
      const r = await b.navigate(url);
      if (!r.ok) return { content: r.error ?? 'Could not open the page.', isError: true };
      return page(ctx, r.error ?? '');
    }
    case 'snapshot':
      return page(ctx, '', a.offset ?? 0);
    case 'click':
      await b.click(needRef());
      return page(ctx, 'Clicked.');
    case 'type': {
      if (a.text === undefined) throw new Error('Action type needs text.');
      await b.type(needRef(), a.text, a.submit === true);
      return page(ctx, 'Typed.');
    }
    case 'press':
      if (!a.key) throw new Error('Action press needs key.');
      await b.press(a.key);
      return page(ctx, `Pressed ${a.key}.`);
    case 'scroll': {
      const dir = (['down', 'up', 'top', 'bottom'] as const).find((d) => d === (a.direction ?? 'down'));
      if (!dir) throw new Error('direction must be down, up, top or bottom.');
      return { content: `Scrolled ${dir}: ${await b.scroll(dir)}.` };
    }
    case 'back':
    case 'reload': {
      if (a.action === 'back') {
        const r = await b.history(-1);
        if (!r.ok) return { content: r.error ?? 'Cannot go back.', isError: true };
      } else await b.reload();
      return page(ctx, a.action === 'back' ? 'Went back.' : 'Reloaded.');
    }
    case 'console': {
      const lines = await b.consoleLines();
      return { content: lines.length ? lines.join('\n') : 'No new console messages or failed requests.', untrusted: !b.isTrustedPage() };
    }
    case 'wait': {
      const found = await b.waitFor(a.text, a.seconds ?? 5);
      return page(ctx, a.text ? (found ? `Found "${a.text}".` : `"${a.text}" did not appear in time.`) : 'Waited.');
    }
    case 'screenshot': {
      if (ctx.vision === false) return { content: 'Screenshots are unavailable: the model runs without an image projector (mmproj). Use snapshot instead.', isError: true };
      const shot = await b.screenshot();
      const dir = join(ctx.cwd, '.gemmacode', 'screens');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `shot-${Date.now().toString(36)}.jpg`);
      writeFileSync(file, shot.data);
      return {
        content: `Screenshot ${shot.width}×${shot.height} saved to .gemmacode/screens/${file.split(/[\\/]/).pop()} and attached below.`,
        images: [file],
        untrusted: !b.isTrustedPage(),
      };
    }
  }
}
