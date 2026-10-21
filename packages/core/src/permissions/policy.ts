import { globToRegExp } from '../tools/glob.ts';
import { displayPath, forbiddenReason, isInside } from '../tools/paths.ts';
import type { Tool, ToolContext, ToolIntent } from '../tools/types.ts';
import { isSafeCommand, mentionsSecret } from './safe-commands.ts';

/** Режимы прав из плана: «только чтение», «спрашивать» (по умолчанию), «авто-правки в проекте», «полный доступ». */
export type PermissionMode = 'read-only' | 'ask' | 'auto-edit' | 'full';

export type Decision =
  | { action: 'allow' }
  /** `sticky`: разрешение (даже разовое) запоминается на сессию, потому что браузер не умеет «один запрос» (домен остаётся открытым для ссылок на странице). */
  | { action: 'ask'; reason: string; grantKey?: string; grantLabel?: string; sticky?: boolean }
  | { action: 'deny'; reason: string };

export interface PermissionRules {
  /** Правила вида `shell(npm test*)`, `edit_file(src/**)`, `write_file`. */
  allow?: string[];
  deny?: string[];
}

export interface PolicyOptions {
  mode: PermissionMode;
  cwd: string;
  /** Команды реально ограничены песочницей ОС. */
  sandboxEnforced: boolean;
  rules?: PermissionRules;
  /** Сайты, которые уже открыты в браузере (например, самим пользователем): повторного вопроса не нужно. */
  isBrowserHostAllowed?: (host: string) => boolean;
}

/**
 * Единственное место, где решается, что можно делать на хосте. Ядро не вызывает инструмент, пока политика
 * не вернула `allow` (или пользователь не подтвердил `ask`).
 */
export class PermissionPolicy {
  mode: PermissionMode;
  /** В сессию попали недоверенные данные (веб, MCP, внешние файлы): записи и команды теперь требуют подтверждения. */
  tainted = false;
  private readonly cwd: string;
  private readonly sandboxEnforced: boolean;
  private readonly rules: PermissionRules;
  private readonly browserHostAllowed: ((host: string) => boolean) | undefined;
  private readonly grants = new Set<string>();

  constructor(opts: PolicyOptions) {
    this.mode = opts.mode;
    this.cwd = opts.cwd;
    this.sandboxEnforced = opts.sandboxEnforced;
    this.rules = opts.rules ?? {};
    this.browserHostAllowed = opts.isBrowserHostAllowed;
  }

  grant(key: string): void {
    this.grants.add(key);
  }

  markTainted(): void {
    this.tainted = true;
  }

  decide(tool: Tool<any>, args: Record<string, unknown>, intent: ToolIntent): Decision {
    const paths = intent.paths ?? [];
    for (const p of paths) {
      const why = forbiddenReason(p);
      if (why) return { action: 'deny', reason: `Access denied: ${why}.` };
    }
    if (intent.command && mentionsSecret(intent.command) && this.mode !== 'full') {
      if (this.mode === 'read-only') return { action: 'deny', reason: 'The command mentions a secrets or browser data location.' };
      return { action: 'ask', reason: 'The command mentions a secrets or browser data location.' };
    }
    const target = intent.command ?? intent.url ?? (paths[0] ? displayPath(this.cwd, paths[0]) : '');
    if (this.matches(this.rules.deny, tool.name, target)) return { action: 'deny', reason: 'Blocked by a deny rule.' };

    const risk = tool.risk;
    if (risk === 'meta') return { action: 'allow' };
    const full = this.mode === 'full';
    const allowedByRule = this.matches(this.rules.allow, tool.name, target);
    const grantKey = risk === 'exec' ? `exec:${intent.command}` : `${risk}:${tool.name}`;
    const granted = this.grants.has(grantKey) || (risk === 'write' && this.grants.has('write:*'));
    const outside = paths.filter((p) => !isInside(this.cwd, p));

    switch (risk) {
      case 'read':
        if (outside.length && !full && !allowedByRule && !granted) {
          return { action: 'ask', reason: `Reads outside the project: ${outside[0]}`, grantKey, grantLabel: `reads of ${tool.name} outside the project` };
        }
        return { action: 'allow' };

      case 'write': {
        if (this.mode === 'read-only') return { action: 'deny', reason: 'Read-only mode: file changes are not allowed.' };
        if (outside.length && !full && !allowedByRule) {
          return { action: 'ask', reason: `Writes outside the project: ${outside[0]}`, grantKey: `write:${outside[0]}`, grantLabel: 'this path' };
        }
        if (full || allowedByRule) return { action: 'allow' };
        if (this.tainted) return { action: 'ask', reason: 'Untrusted content was read in this session.' };
        if (this.mode === 'auto-edit' || granted) return { action: 'allow' };
        return { action: 'ask', reason: 'File change', grantKey: 'write:*', grantLabel: 'all file edits in this session' };
      }

      case 'exec': {
        const network = args.network === true;
        const safe = !network && isSafeCommand(intent.command ?? '');
        if (this.mode === 'read-only') {
          return safe ? { action: 'allow' } : { action: 'deny', reason: 'Read-only mode: only read-only commands are allowed.' };
        }
        if (full) return { action: 'allow' };
        if (safe) return { action: 'allow' };
        if (allowedByRule && !network) return { action: 'allow' };
        const reason = !this.sandboxEnforced
          ? 'No OS sandbox on this system: every command needs approval.'
          : this.tainted
            ? 'Untrusted content was read in this session.'
            : network
              ? 'The command asks for network access.'
              : 'Command';
        if (granted && this.sandboxEnforced && !this.tainted && !network) return { action: 'allow' };
        return { action: 'ask', reason, grantKey, grantLabel: 'this exact command in this session' };
      }

      case 'host':
        if (full) return { action: 'allow' };
        return { action: 'ask', reason: 'Controls a program on this computer' };

      case 'browser': {
        const action = String(args.action ?? '');
        if (action !== 'open') {
          // клики и ввод меняют состояние чужих сайтов, в режиме чтения их нет; всё остальное только смотрит
          if (this.mode === 'read-only' && (action === 'click' || action === 'type' || action === 'press')) return { action: 'deny', reason: 'Read-only mode: clicking and typing in the browser are not allowed.' };
          return { action: 'allow' };
        }
        if (!intent.url) return { action: 'deny', reason: 'This is not an address the browser can open. Use http(s)://…, localhost:PORT or a project file path.' };
        let u: URL;
        try {
          u = new URL(intent.url);
        } catch {
          return { action: 'deny', reason: 'Invalid address.' };
        }
        if (u.protocol === 'about:') return { action: 'allow' };
        if (u.protocol === 'file:') {
          if (outside.length && !full && !allowedByRule) return { action: 'ask', reason: `Opens a file outside the project: ${outside[0]}`, grantKey: `browser:file:${outside[0]}`, grantLabel: 'this file', sticky: true };
          return { action: 'allow' };
        }
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]') return { action: 'allow' };
        if (full || allowedByRule || this.grants.has(`browser:host:${host}`) || this.browserHostAllowed?.(host)) return { action: 'allow' };
        if (this.mode === 'read-only') return { action: 'deny', reason: `Read-only mode: the browser may only open local pages (${host} is not local).` };
        return { action: 'ask', reason: `Opens a website: ${host}`, grantKey: `browser:host:${host}`, grantLabel: `${host} in this session`, sticky: true };
      }

      case 'external':
        if (full || allowedByRule || granted) return { action: 'allow' };
        return { action: 'ask', reason: 'External tool (MCP)', grantKey, grantLabel: `${tool.name} in this session` };
    }
  }

  private matches(rules: string[] | undefined, toolName: string, target: string): boolean {
    for (const r of rules ?? []) {
      const m = /^([\w.\-:*]+)(?:\((.*)\))?$/.exec(r.trim());
      if (!m) continue;
      if (!wildcard(m[1]!).test(toolName)) continue;
      if (m[2] === undefined) return true;
      const pat = m[2];
      if (toolName === 'shell') {
        if (wildcard(pat).test(target)) return true;
      } else {
        const rel = target.startsWith('/') ? target : target;
        if (globToRegExp(pat.includes('/') ? pat : `**/${pat}`).test(rel)) return true;
      }
    }
    return false;
  }
}

function wildcard(p: string): RegExp {
  return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

export type { ToolContext };
