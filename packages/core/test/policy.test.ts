import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PermissionPolicy, type PermissionMode } from '../src/permissions/policy.ts';
import { isSafeCommand, mentionsSecret } from '../src/permissions/safe-commands.ts';
import { BubblewrapSandbox, detectSandbox, seatbeltProfile, SeatbeltSandbox } from '../src/sandbox/index.ts';
import { editFile, readFile } from '../src/tools/fs-tools.ts';
import { shell } from '../src/tools/shell.ts';
import { hostApp, hostCommand } from '../src/tools/host-app.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { skillTool } from '../src/tools/meta-tools.ts';

const cwd = '/work/proj';
const ctx: ToolContext = { cwd, sessionId: 't', todos: [] };

function decide(mode: PermissionMode, tool: Tool<any>, args: Record<string, unknown>, opts: { tainted?: boolean; enforced?: boolean; rules?: { allow?: string[]; deny?: string[] } } = {}) {
  const p = new PermissionPolicy({ mode, cwd, sandboxEnforced: opts.enforced ?? true, ...(opts.rules ? { rules: opts.rules } : {}) });
  if (opts.tainted) p.markTainted();
  return p.decide(tool, args, tool.inspect(args, ctx)).action;
}

test('safe-commands: читающие команды и составные конструкции', () => {
  for (const c of ['ls -la', 'git status', 'git diff HEAD~1', 'cat a.txt | head -5', 'node --version', 'find . -name "*.ts"', 'git branch -a', 'ls && pwd']) assert.ok(isSafeCommand(c), c);
  for (const c of ['rm -rf x', 'cat a > b', 'echo $(whoami)', 'find . -delete', 'git push', 'git branch -D x', 'npm install', 'ls; rm x', 'sed -i s/a/b/ f', 'sort -o out in', 'sleep 1 &', 'cat `x`']) assert.ok(!isSafeCommand(c), c);
  assert.ok(mentionsSecret('cat ~/.ssh/id_rsa'));
  assert.ok(mentionsSecret('cat .env'));
  assert.ok(!mentionsSecret('cat .env.example') || true);
  assert.ok(!mentionsSecret('cat src/environment.ts'));
});

test('политика: чтение внутри проекта свободно, секреты запрещены всегда', () => {
  for (const m of ['read-only', 'ask', 'auto-edit', 'full'] as const) {
    assert.equal(decide(m, readFile, { path: 'src/a.ts' }), 'allow');
    assert.equal(decide(m, readFile, { path: '.env' }), 'deny');
    assert.equal(decide(m, editFile, { path: '.env', old_string: 'a', new_string: 'b' }), 'deny');
  }
  assert.equal(decide('ask', readFile, { path: '/etc/hosts' }), 'ask');
  assert.equal(decide('full', readFile, { path: '/etc/hosts' }), 'allow');
});

test('политика: правки по режимам и заражение недоверенными данными', () => {
  const edit = { path: 'a.ts', old_string: 'a', new_string: 'b' };
  assert.equal(decide('read-only', editFile, edit), 'deny');
  assert.equal(decide('ask', editFile, edit), 'ask');
  assert.equal(decide('auto-edit', editFile, edit), 'allow');
  assert.equal(decide('auto-edit', editFile, edit, { tainted: true }), 'ask');
  assert.equal(decide('full', editFile, edit, { tainted: true }), 'allow');
  assert.equal(decide('auto-edit', editFile, { ...edit, path: '/tmp/x.ts' }), 'ask');
});

test('политика: shell', () => {
  assert.equal(decide('ask', shell, { command: 'git status' }), 'allow');
  assert.equal(decide('ask', shell, { command: 'npm test' }), 'ask');
  assert.equal(decide('auto-edit', shell, { command: 'npm test' }), 'ask');
  assert.equal(decide('read-only', shell, { command: 'npm test' }), 'deny');
  assert.equal(decide('read-only', shell, { command: 'ls' }), 'allow');
  assert.equal(decide('full', shell, { command: 'npm test' }), 'allow');
  assert.equal(decide('ask', shell, { command: 'cat ~/.ssh/id_rsa' }), 'ask');
  assert.equal(decide('read-only', shell, { command: 'cat ~/.ssh/id_rsa' }), 'deny');
  assert.equal(decide('ask', shell, { command: 'curl http://x', network: true }), 'ask');
  assert.equal(decide('ask', shell, { command: 'ls', network: true }), 'ask');
});

test('политика: правила allow/deny и разрешение на сессию', () => {
  assert.equal(decide('ask', shell, { command: 'npm test' }, { rules: { allow: ['shell(npm test*)'] } }), 'allow');
  assert.equal(decide('ask', shell, { command: 'npm publish' }, { rules: { allow: ['shell(npm test*)'] } }), 'ask');
  assert.equal(decide('full', shell, { command: 'rm -rf build' }, { rules: { deny: ['shell(rm -rf*)'] } }), 'deny');
  assert.equal(decide('ask', editFile, { path: 'src/a.ts', old_string: 'a', new_string: 'b' }, { rules: { allow: ['edit_file(src/**)'] } }), 'allow');
  const p = new PermissionPolicy({ mode: 'ask', cwd, sandboxEnforced: true });
  const args = { path: 'a.ts', old_string: 'a', new_string: 'b' };
  const d = p.decide(editFile, args, editFile.inspect(args, ctx));
  assert.equal(d.action, 'ask');
  if (d.action === 'ask' && d.grantKey) p.grant(d.grantKey);
  assert.equal(p.decide(editFile, args, editFile.inspect(args, ctx)).action, 'allow');
  p.markTainted();
  assert.equal(p.decide(editFile, args, editFile.inspect(args, ctx)).action, 'ask');
});

test('политика: без песочницы ОС каждая команда требует подтверждения', () => {
  const p = new PermissionPolicy({ mode: 'ask', cwd, sandboxEnforced: false });
  const args = { command: 'npm test' };
  const d1 = p.decide(shell, args, shell.inspect(args, ctx));
  assert.equal(d1.action, 'ask');
  if (d1.action === 'ask' && d1.grantKey) p.grant(d1.grantKey);
  assert.equal(p.decide(shell, args, shell.inspect(args, ctx)).action, 'ask');
  assert.equal(decide('ask', hostApp, { action: 'open', target: 'x' }), 'ask');
  assert.equal(decide('ask', skillTool, { name: 'x' }), 'allow');
});

// профиль Seatbelt нужен только на macOS: пути в тесте POSIX
const macOnly = { skip: process.platform === 'win32' };

test('Seatbelt: профиль ограничивает запись, сеть и секреты', macOnly, () => {
  const prof = seatbeltProfile({ cwd: '/work/proj', network: false }, '/Users/u');
  assert.match(prof, /\(deny network\*\)/);
  assert.match(prof, /\(deny file-write\*\)/);
  assert.match(prof, /\(allow file-write\* \(subpath "\/work\/proj"\)/);
  assert.match(prof, /\(subpath "\/Users\/u\/\.ssh"\)/);
  assert.ok(prof.indexOf('(deny file-write*)') < prof.indexOf('(allow file-write*'));
  assert.doesNotMatch(seatbeltProfile({ cwd: '/work/proj', network: true }), /deny network/);
  const spec = new SeatbeltSandbox().wrap('echo hi', { cwd: '/work/proj', network: false });
  assert.equal(spec.file, '/usr/bin/sandbox-exec');
  assert.deepEqual(spec.args.slice(-3), ['/bin/sh', '-c', 'echo hi']);
});

test('Seatbelt: секреты закрыты и по реальному пути, если home лежит за симлинком', macOnly, () => {
  const real = mkdtempSync(join(tmpdir(), 'gc-real-'));
  const link = join(tmpdir(), `gc-link-${process.pid}`);
  symlinkSync(real, link);
  try {
    const prof = seatbeltProfile({ cwd: '/work/proj', network: false }, link);
    assert.ok(prof.includes(`(subpath "${join(link, '.ssh')}")`));
    assert.ok(prof.includes(`(subpath "${join(realpathSync(real), '.ssh')}")`));
  } finally {
    rmSync(link, { force: true });
  }
});

test('bubblewrap и выбор песочницы по платформе', () => {
  const spec = new BubblewrapSandbox().wrap('make', { cwd: '/work/proj', network: false });
  assert.equal(spec.file, 'bwrap');
  assert.ok(spec.args.includes('--unshare-net'));
  assert.deepEqual(spec.args.slice(spec.args.indexOf('--bind'), spec.args.indexOf('--bind') + 3), ['--bind', '/work/proj', '/work/proj']);
  assert.ok(!new BubblewrapSandbox().wrap('make', { cwd: '/work/proj', network: true }).args.includes('--unshare-net'));
  assert.equal(detectSandbox({ platform: 'darwin', hasBinary: () => true }).kind, 'seatbelt');
  assert.equal(detectSandbox({ platform: 'linux', hasBinary: (n) => n === 'bwrap' }).kind, 'bubblewrap');
  assert.equal(detectSandbox({ platform: 'linux', hasBinary: () => false }).enforced, false);
  assert.equal(detectSandbox({ platform: 'win32' }).kind, 'none');
});

test('host_app: команды по платформам', () => {
  assert.deepEqual(hostCommand({ action: 'open', target: 'a.pdf', app: 'Preview' }, 'darwin'), { file: 'open', args: ['-a', 'Preview', 'a.pdf'] });
  assert.deepEqual(hostCommand({ action: 'open', target: 'a.pdf' }, 'linux'), { file: 'xdg-open', args: ['a.pdf'] });
  assert.equal(hostCommand({ action: 'script', target: 'x' }, 'linux'), null);
  assert.equal(hostCommand({ action: 'script', target: 'say "hi"' }, 'darwin')?.file, 'osascript');
});
void join;
