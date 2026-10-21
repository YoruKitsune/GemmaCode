import { existsSync } from 'node:fs';

/** Минимум от node-pty, который нам нужен (сам пакет подключается лениво: на платформе без сборки терминала просто не будет). */
interface Pty {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): Pty;
}

export interface TerminalEvents {
  data(id: string, data: string): void;
  exit(id: string, code: number | null): void;
}

const MAX_TERMINALS = 4;

export function defaultShell(env = process.env, platform = process.platform): string {
  if (platform === 'win32') return env.ComSpec || 'powershell.exe';
  if (env.SHELL && existsSync(env.SHELL)) return env.SHELL;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

/** Терминалы пользователя в корне проекта. Команды агента идут отдельно (инструмент shell в песочнице) и в эти терминалы не попадают. */
export class Terminals {
  private readonly ptys = new Map<string, Pty>();
  private n = 0;
  private mod: Promise<PtyModule | null> | undefined;
  private readonly events: TerminalEvents;
  private readonly loader: () => Promise<PtyModule>;

  constructor(events: TerminalEvents, loader: () => Promise<PtyModule> = () => import('@lydell/node-pty' as string) as Promise<PtyModule>) {
    this.events = events;
    this.loader = loader;
  }

  private load(): Promise<PtyModule | null> {
    this.mod ??= this.loader().then((m) => ((m as unknown as { default?: PtyModule }).default ?? m), () => null);
    return this.mod;
  }

  async open(cwd: string, cols: number, rows: number): Promise<{ id: string; shell: string }> {
    if (this.ptys.size >= MAX_TERMINALS) throw new Error(`Не больше ${MAX_TERMINALS} терминалов одновременно`);
    const pty = await this.load();
    if (!pty) throw new Error('Терминал недоступен: не загрузился node-pty для этой платформы');
    const shell = defaultShell();
    const id = `t${++this.n}`;
    const p = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    p.onData((d) => this.events.data(id, d));
    p.onExit((e) => {
      this.ptys.delete(id);
      this.events.exit(id, e.exitCode);
    });
    this.ptys.set(id, p);
    return { id, shell };
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      // процесс уже завершился
    }
  }

  close(id: string): void {
    const p = this.ptys.get(id);
    this.ptys.delete(id);
    try {
      p?.kill();
    } catch {
      // уже завершён
    }
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id);
  }
}
