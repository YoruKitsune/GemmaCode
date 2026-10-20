import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_HOME_PATHS } from '../tools/paths.ts';

export type SandboxKind = 'seatbelt' | 'bubblewrap' | 'none';

export interface SandboxPolicy {
  /** Корень проекта: единственное место, куда команда может писать (кроме временных каталогов). */
  cwd: string;
  network: boolean;
}

export interface SpawnSpec {
  file: string;
  args: string[];
}

export interface SandboxRunner {
  readonly kind: SandboxKind;
  /** true, если команды реально ограничены ОС; без этого права требуют подтверждения каждой команды. */
  readonly enforced: boolean;
  wrap(command: string, policy: SandboxPolicy): SpawnSpec;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const sbString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Профиль macOS Seatbelt: запись только в проект и временные каталоги, сеть выключена, секреты нельзя читать.
 * Порядок правил важен: более поздние правила переопределяют более ранние.
 */
export function seatbeltProfile(policy: SandboxPolicy, home = homedir()): string {
  const writable = [real(policy.cwd), real(tmpdir()), '/private/tmp', '/private/var/folders'];
  const lines = ['(version 1)', '(allow default)'];
  if (!policy.network) lines.push('(deny network*)', '(allow network* (remote unix-socket))');
  lines.push('(deny file-write*)');
  lines.push(`(allow file-write* ${writable.map((p) => `(subpath ${sbString(p)})`).join(' ')})`);
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))');
  const secrets = SECRET_HOME_PATHS.map((p) => `(subpath ${sbString(join(home, p))})`);
  lines.push(`(deny file-read* ${secrets.join(' ')})`);
  // Внутри проекта защищённые файлы остаются читаемыми через инструменты агента, но не через shell.
  lines.push(`(deny file-read* (regex #"/\\.env($|\\.[^/]*$)") (regex #"/id_(rsa|dsa|ecdsa|ed25519)$"))`);
  lines.push(`(allow file-read* (regex #"/\\.env\\.(example|sample|template|dist)$"))`);
  return lines.join('\n');
}

export class SeatbeltSandbox implements SandboxRunner {
  readonly kind = 'seatbelt' as const;
  readonly enforced = true;
  wrap(command: string, policy: SandboxPolicy): SpawnSpec {
    return { file: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(policy), '/bin/sh', '-c', command] };
  }
}

export class BubblewrapSandbox implements SandboxRunner {
  readonly kind = 'bubblewrap' as const;
  readonly enforced = true;
  private readonly bin: string;
  constructor(bin = 'bwrap') {
    this.bin = bin;
  }
  wrap(command: string, policy: SandboxPolicy, home = homedir()): SpawnSpec {
    const cwd = real(policy.cwd);
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', cwd, cwd];
    for (const p of SECRET_HOME_PATHS) args.push('--tmpfs', join(home, p));
    if (!policy.network) args.push('--unshare-net');
    args.push('--unshare-pid', '--die-with-parent', '--new-session', '--chdir', cwd, '/bin/sh', '-c', command);
    return { file: this.bin, args };
  }
}

/** Без песочницы (Windows, Linux без bubblewrap): команда запускается напрямую, а права требуют подтверждения каждой. */
export class NoSandbox implements SandboxRunner {
  readonly kind = 'none' as const;
  readonly enforced = false;
  wrap(command: string): SpawnSpec {
    return process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] } : { file: '/bin/sh', args: ['-c', command] };
  }
}

export function detectSandbox(opts: { platform?: NodeJS.Platform; hasBinary?: (name: string) => boolean } = {}): SandboxRunner {
  const platform = opts.platform ?? process.platform;
  const has = opts.hasBinary ?? defaultHasBinary;
  if (platform === 'darwin' && has('/usr/bin/sandbox-exec')) return new SeatbeltSandbox();
  if (platform === 'linux' && has('bwrap')) return new BubblewrapSandbox();
  return new NoSandbox();
}

function defaultHasBinary(name: string): boolean {
  const dirs = name.startsWith('/') ? [''] : (process.env.PATH ?? '').split(':');
  for (const d of dirs) {
    try {
      realpathSync(join(d, name));
      return true;
    } catch {
      // нет в этом каталоге
    }
  }
  return false;
}
