import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { validateArgs } from '../src/tools/validate.ts';
import { applyEdit, editFile, globTool, grep, listDir, readFile, writeFile } from '../src/tools/fs-tools.ts';
import { forbiddenReason, isInside } from '../src/tools/paths.ts';
import { globToRegExp } from '../src/tools/glob.ts';
import { shell } from '../src/tools/shell.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempProject } from './helpers.ts';

const mkCtx = (cwd: string, extra: Partial<ToolContext> = {}): ToolContext => ({ cwd, sessionId: 't', todos: [], ...extra });

test('validateArgs: приводит типы и сообщает понятные ошибки', () => {
  const ok = validateArgs(readFile.parameters, '{"path":"a.ts","limit":"20"}', 'read_file');
  assert.ok(ok.ok && ok.args.limit === 20);
  const bad = validateArgs(readFile.parameters, '{"file":"a.ts"}', 'read_file');
  assert.ok(!bad.ok && /unknown argument "file"/.test(bad.error) && /missing required argument "path"/.test(bad.error));
  const notJson = validateArgs(readFile.parameters, '{path:', 'read_file');
  assert.ok(!notJson.ok && /not valid JSON/.test(notJson.error));
  const empty = validateArgs(listDir.parameters, '', 'list_dir');
  assert.ok(empty.ok);
});

test('read_file: диапазоны и бинарные файлы', async () => {
  const dir = tempProject({ 'a.txt': Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n' });
  writeFileSync(join(dir, 'b.bin'), Buffer.from([1, 2, 0, 3]));
  const all = await readFile.run({ path: 'a.txt' }, mkCtx(dir));
  assert.equal(all.content.split('\n').length, 10);
  const part = await readFile.run({ path: 'a.txt', offset: 3, limit: 2 }, mkCtx(dir));
  assert.match(part.content, /^\[lines 3-4 of 10\]/);
  assert.match(part.content, /offset=5/);
  const bin = await readFile.run({ path: 'b.bin' }, mkCtx(dir));
  assert.ok(bin.isError && /binary/.test(bin.content));
  const missing = await readFile.run({ path: 'nope' }, mkCtx(dir));
  assert.ok(missing.isError);
});

test('edit_file: точная замена, неоднозначность, replace_all, CRLF', async () => {
  const dir = tempProject({ 'f.ts': 'const a = 1;\nconst b = 1;\nfoo();\nfoo();\n', 'w.txt': 'one\r\ntwo\r\n' });
  const ctx = mkCtx(dir);
  const amb = await editFile.run({ path: 'f.ts', old_string: 'foo();', new_string: 'bar();' }, ctx);
  assert.ok(amb.isError && /2 times/.test(amb.content));
  const all = await editFile.run({ path: 'f.ts', old_string: 'foo();', new_string: 'bar();', replace_all: true }, ctx);
  assert.ok(!all.isError);
  assert.equal(readFileSync(join(dir, 'f.ts'), 'utf8'), 'const a = 1;\nconst b = 1;\nbar();\nbar();\n');
  const crlf = await editFile.run({ path: 'w.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' }, ctx);
  assert.ok(!crlf.isError);
  assert.equal(readFileSync(join(dir, 'w.txt'), 'utf8'), 'uno\r\ndos\r\n');
  const missing = await editFile.run({ path: 'f.ts', old_string: 'zzz', new_string: 'y' }, ctx);
  assert.ok(missing.isError && /not found/.test(missing.content));
});

test('applyEdit: нечёткое совпадение по отступам сохраняет отступ файла', () => {
  const text = 'function f() {\n    if (x) {\n        return 1;\n    }\n}\n';
  const r = applyEdit(text, 'if (x) {\n  return 1;\n}', 'if (x) {\n  return 2;\n}', false);
  assert.ok(r.ok && r.fuzzy);
  if (r.ok) assert.equal(r.text, 'function f() {\n    if (x) {\n        return 2;\n    }\n}\n');
});

test('write_file создаёт каталоги и пишет снимок для отката', async () => {
  const dir = tempProject({ 'keep.txt': 'original' });
  const snaps = new SnapshotStore(dir, 's1');
  const ctx = mkCtx(dir, { snapshots: snaps });
  snaps.begin('turn 1');
  await writeFile.run({ path: 'new/dir/x.txt', content: 'hello' }, ctx);
  await writeFile.run({ path: 'keep.txt', content: 'changed' }, ctx);
  await editFile.run({ path: 'keep.txt', old_string: 'changed', new_string: 'changed twice' }, ctx);
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'changed twice');
  assert.deepEqual(snaps.changedSince(1), ['keep.txt', 'new/dir/x.txt']);
  snaps.rollbackTo(1);
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'original');
  assert.ok(!existsSync(join(dir, 'new/dir/x.txt')));
});

test('откат к середине: два хода, откат только последнего', async () => {
  const dir = tempProject({ 'a.txt': 'v0' });
  const snaps = new SnapshotStore(dir, 's2');
  const ctx = mkCtx(dir, { snapshots: snaps });
  snaps.begin('one');
  await writeFile.run({ path: 'a.txt', content: 'v1' }, ctx);
  snaps.begin('two');
  await writeFile.run({ path: 'a.txt', content: 'v2' }, ctx);
  snaps.rollbackTo(2);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'v1');
  assert.equal(snaps.list().length, 1);
  // состояние переживает перезапуск
  assert.equal(new SnapshotStore(dir, 's2').list().length, 1);
});

test('glob и grep учитывают .gitignore и node_modules', async () => {
  const dir = tempProject({
    'src/a.ts': 'export const needle = 1;\n',
    'src/deep/b.ts': 'const x = "Needle";\n',
    'src/c.js': 'nothing\n',
    'node_modules/pkg/index.ts': 'needle\n',
    'build/out.ts': 'needle\n',
    '.gitignore': 'build/\n*.log\n',
    'run.log': 'needle\n',
  });
  const ctx = mkCtx(dir);
  const g = await globTool.run({ pattern: '*.ts' }, ctx);
  assert.equal(g.content, 'src/a.ts\nsrc/deep/b.ts');
  const g2 = await globTool.run({ pattern: 'src/**/*.ts' }, ctx);
  assert.equal(g2.content, 'src/a.ts\nsrc/deep/b.ts');
  const r = await grep.run({ pattern: 'needle' }, ctx);
  assert.equal(r.content, 'src/a.ts:1: export const needle = 1;');
  const ri = await grep.run({ pattern: 'needle', ignore_case: true, glob: '*.ts' }, ctx);
  assert.equal(ri.content.split('\n').length, 2);
  const bad = await grep.run({ pattern: '(' }, ctx);
  assert.ok(bad.isError);
});

test('list_dir: каталоги первыми, .git скрыт', async () => {
  const dir = tempProject({ 'z.txt': '', 'a/b.txt': '', '.git/HEAD': '' });
  const r = await listDir.run({ path: '.' }, mkCtx(dir));
  assert.equal(r.content, 'a/\nz.txt');
});

test('globToRegExp: фигурные скобки и **', () => {
  assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b/c.tsx'));
  assert.ok(globToRegExp('**/*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('src/a.ts'));
});

test('пути: выход через симлинк и запретный список', () => {
  const dir = tempProject({ 'a.txt': 'x' });
  const out = tempProject({ 'secret.txt': 's' });
  symlinkSync(out, join(dir, 'link'));
  assert.ok(isInside(dir, join(dir, 'a.txt')));
  assert.ok(!isInside(dir, join(dir, 'link', 'secret.txt')));
  assert.ok(!isInside(dir, join(dir, '..', 'other')));
  assert.match(forbiddenReason(join(dir, '.env')) ?? '', /secrets/);
  assert.equal(forbiddenReason(join(dir, '.env.example')), null);
  assert.match(forbiddenReason('/home/u/.ssh/id_rsa', '/home/u') ?? '', /protected|secrets/);
  assert.equal(forbiddenReason(join(dir, 'a.txt')), null);
});

test('shell: вывод, код выхода, таймаут, окружение без секретов', async () => {
  const dir = tempProject();
  const ctx = mkCtx(dir);
  // на Windows команды идут через cmd.exe: тот же сценарий в его синтаксисе
  const win = process.platform === 'win32';
  const ok = await shell.run({ command: win ? 'echo hi && cd' : 'echo hi && pwd' }, ctx);
  assert.match(ok.content, /hi/);
  assert.match(ok.content, /\[exit code 0\]/);
  const fail = await shell.run({ command: win ? 'echo oops 1>&2 & exit 3' : 'echo oops >&2; exit 3' }, ctx);
  assert.ok(fail.isError && /exit code 3/.test(fail.content) && /oops/.test(fail.content));
  const slow = await shell.run({ command: win ? 'ping -n 6 127.0.0.1 > nul' : 'sleep 5', timeout_s: 1 }, ctx);
  assert.ok(slow.isError && /timed out/.test(slow.content));
  process.env.MY_API_TOKEN = 'leak';
  const env = await shell.run({ command: win ? 'if defined MY_API_TOKEN (echo [leak]) else (echo [])' : 'echo "[$MY_API_TOKEN]"' }, ctx);
  assert.match(env.content, /\[\]/);
  delete process.env.MY_API_TOKEN;
});
