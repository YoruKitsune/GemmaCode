import { spawn } from 'node:child_process';
import { truncateMiddle } from '../context/truncate.ts';
import { detectSandbox } from '../sandbox/index.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const MAX_OUTPUT_CHARS = 8000;
const MAX_CAPTURE = 2_000_000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

const SECRET_ENV = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i;

/** Окружение для команд: без токенов и ключей, чтобы они не утекали в вывод и скрипты. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

export interface ShellArgs {
  command: string;
  timeout_s?: number;
  network?: boolean;
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
    const sandbox = ctx.sandbox ?? detectSandbox();
    const spec = sandbox.wrap(a.command, { cwd: ctx.cwd, network: a.network === true });
    const timeoutMs = Math.min(Math.max(a.timeout_s ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S) * 1000;
    return await new Promise<ToolResult>((resolve) => {
      let out = '';
      let timedOut = false;
      let aborted = false;
      const child = spawn(spec.file, spec.args, {
        cwd: ctx.cwd,
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
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      const collect = (d: Buffer): void => {
        if (out.length < MAX_CAPTURE) out += d.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ content: `Failed to start the command: ${e.message}`, isError: true });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        const body = truncateMiddle(out.trimEnd(), MAX_OUTPUT_CHARS);
        const status = timedOut
          ? `[timed out after ${timeoutMs / 1000}s]`
          : aborted
            ? '[interrupted]'
            : signal
              ? `[killed by ${signal}]`
              : `[exit code ${code}]`;
        resolve({ content: body ? `${body}\n${status}` : status, isError: timedOut || aborted || code !== 0 });
      });
    });
  },
};

export type { ToolContext };
