import { spawn } from 'node:child_process';
import type { Tool } from './types.ts';

interface HostAppArgs {
  action: 'open' | 'script';
  target: string;
  app?: string;
}

/** Запуск программ хоста через CLI платформы. Всегда с подтверждением, песочница к GUI неприменима. */
export const hostApp: Tool<HostAppArgs> = {
  name: 'host_app',
  description: 'Open a file, URL or application on this computer (action "open"), or run an AppleScript/PowerShell snippet (action "script").',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'open or script', enum: ['open', 'script'] },
      target: { type: 'string', description: 'File, URL or app name to open; or the script text' },
      app: { type: 'string', description: 'Application to open the target with, optional' },
    },
    required: ['action', 'target'],
    additionalProperties: false,
  },
  risk: 'host',
  inspect: (a) => ({ summary: a.action === 'open' ? `open ${a.target}${a.app ? ` with ${a.app}` : ''}` : `run script: ${a.target.slice(0, 80)}` }),
  async run(a, ctx) {
    const spec = hostCommand(a, process.platform);
    if (!spec) return { content: `Action "${a.action}" is not supported on ${process.platform}.`, isError: true };
    return await new Promise((resolve) => {
      let out = '';
      const child = spawn(spec.file, spec.args, { cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ content: `Failed: ${e.message}`, isError: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ content: (out.trim() || (code === 0 ? 'Done.' : `Exit code ${code}`)).slice(0, 4000), isError: code !== 0 });
      });
    });
  },
};

export function hostCommand(a: HostAppArgs, platform: NodeJS.Platform): { file: string; args: string[] } | null {
  if (a.action === 'script') {
    if (platform === 'darwin') return { file: 'osascript', args: ['-e', a.target] };
    if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', a.target] };
    return null;
  }
  if (platform === 'darwin') return { file: 'open', args: a.app ? ['-a', a.app, a.target] : [a.target] };
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/c', 'start', '""', ...(a.app ? [a.app] : []), a.target] };
  return { file: 'xdg-open', args: [a.target] };
}
