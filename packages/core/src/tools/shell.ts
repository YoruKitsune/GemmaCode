import { spawn } from 'node:child_process';
import { truncateMiddle } from '../context/truncate.ts';
import { detectSandbox } from '../sandbox/index.ts';
import type { SandboxRunner } from '../sandbox/index.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const MAX_OUTPUT_CHARS = 8000;
const MAX_CAPTURE = 2_000_000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

const SECRET_ENV = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i;

/** Окружение для команд: без токенов и ключей, чтобы они не утекали в вывод и скрипты. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k) && k !== 'NODE_TEST_CONTEXT') out[k] = v;
  return out;
}

export interface ShellArgs {
  command: string;
  timeout_s?: number;
  network?: boolean;
}

export interface ExecOptions {
  cwd: string;
  sandbox?: SandboxRunner;
  timeoutS?: number;
  network?: boolean;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

export interface ExecOutcome {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  signal: string | null;
  spawnError?: string;
}

/** Запуск команды под песочницей с таймаутом и сбором вывода. Используется инструментом shell и проверками режима loop. */
export function execCommand(command: string, o: ExecOptions): Promise<ExecOutcome> {
  const sandbox = o.sandbox ?? detectSandbox();
  const spec = sandbox.wrap(command, { cwd: o.cwd, network: o.network === true });
  const timeoutMs = Math.min(Math.max(o.timeoutS ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S) * 1000;
  return new Promise<ExecOutcome>((resolve) => {
    let out = '';
    let timedOut = false;
    let aborted = false;
    const child = spawn(spec.file, spec.args, {
      cwd: o.cwd,
      env: cleanEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const killTree = (): void => {
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // процесс уже завершился
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (d: Buffer): void => {
      if (out.length < MAX_CAPTURE) out += d.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ output: '', exitCode: null, timedOut: false, aborted: false, signal: null, spawnError: e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ output: truncateMiddle(out.trimEnd(), o.maxOutputChars ?? MAX_OUTPUT_CHARS), exitCode: code, timedOut, aborted, signal });
    });
  });
}

export const shell: Tool<ShellArgs> = {
  name: 'shell',
  description: 'Run a shell command in the project root (build, tests, git, scripts). Returns output and exit code. Network is off unless network is true.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line' },
      timeout_s: { type: 'integer', description: 'Time limit in seconds, default 60' },
      network: { type: 'boolean', description: 'Allow network access for this command' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  risk: 'exec',
  inspect: (a) => ({ summary: `$ ${a.command}`, command: a.command }),
  async run(a, ctx): Promise<ToolResult> {
    const r = await execCommand(a.command, {
      cwd: ctx.cwd,
      ...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}),
      ...(a.timeout_s !== undefined ? { timeoutS: a.timeout_s } : {}),
      ...(a.network !== undefined ? { network: a.network } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (r.spawnError) return { content: `Failed to start the command: ${r.spawnError}`, isError: true };
    const status = r.timedOut
      ? `[timed out after ${Math.min(Math.max(a.timeout_s ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S)}s]`
      : r.aborted
        ? '[interrupted]'
        : r.signal
          ? `[killed by ${r.signal}]`
          : `[exit code ${r.exitCode}]`;
    return { content: r.output ? `${r.output}\n${status}` : status, isError: r.timedOut || r.aborted || r.exitCode !== 0 };
  },
};

export type { ToolContext };
