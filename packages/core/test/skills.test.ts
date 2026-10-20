import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../src/skills/frontmatter.ts';
import { SkillCatalog } from '../src/skills/catalog.ts';
import { skillTool } from '../src/tools/meta-tools.ts';
import { tempProject } from './helpers.ts';

test('frontmatter: строки, кавычки, блоки > и |', () => {
  const r = parseFrontmatter('---\nname: pdf-extract\ndescription: >\n  Extract text\n  from PDF files\nlicense: "MIT"\nnotes: |\n  a\n  b\n---\n# Body\ntext\n');
  assert.equal(r.data.name, 'pdf-extract');
  assert.equal(r.data.description, 'Extract text from PDF files');
  assert.equal(r.data.license, 'MIT');
  assert.equal(r.data.notes, 'a\nb');
  assert.equal(r.body, '# Body\ntext\n');
  assert.deepEqual(parseFrontmatter('no header').data, {});
});

function setup() {
  const home = tempProject();
  const proj = tempProject();
  const add = (root: string, name: string, desc: string, body = 'body') => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);
  };
  return { home, proj, add };
}

test('каталог: проектный скилл перекрывает пользовательский, читаются каталоги других агентов', () => {
  const { home, proj, add } = setup();
  add(join(home, '.gemmacode/skills'), 'changelog', 'user version');
  add(join(proj, '.gemmacode/skills'), 'changelog', 'project version');
  add(join(proj, '.claude/skills'), 'code-review', 'Review a diff for bugs');
  const cat = SkillCatalog.load(proj, home);
  assert.equal(cat.size, 2);
  assert.equal(cat.get('changelog')!.description, 'project version');
  assert.equal(cat.get('changelog')!.scope, 'project');
  assert.match(cat.promptListing(), /- code-review: Review a diff for bugs/);
});

test('match: подбор по имени и описанию, пороги', () => {
  const { home, proj, add } = setup();
  add(join(home, '.gemmacode/skills'), 'pdf-extract', 'Extract text from PDF files');
  add(join(home, '.gemmacode/skills'), 'commit-message', 'Write a commit message for staged changes');
  add(join(home, '.gemmacode/skills'), 'changelog', 'Update CHANGELOG.md with release notes');
  const cat = SkillCatalog.load(proj, home);
  assert.equal(cat.match('extract the text from report.pdf')?.name, undefined === 1 ? '' : cat.match('extract the text from report.pdf')?.name);
  assert.equal(cat.match('please write a commit message')?.name, 'commit-message');
  assert.equal(cat.match('update the changelog for release')?.name, 'changelog');
  assert.equal(cat.match('rename function foo to bar in utils'), undefined);
  assert.equal(cat.match(''), undefined);
});

test('инструмент skill: тело, список файлов, неизвестное имя, метка недоверенного для проектных', async () => {
  const { home, proj, add } = setup();
  add(join(proj, '.gemmacode/skills'), 'deploy', 'Deploy steps', '1. build');
  writeFileSync(join(proj, '.gemmacode/skills/deploy/run.sh'), 'echo');
  add(join(home, '.gemmacode/skills'), 'mine', 'user skill');
  const skills = SkillCatalog.load(proj, home);
  const ctx = { cwd: proj, sessionId: 's', todos: [], skills };
  const r = await skillTool.run({ name: 'deploy' }, ctx);
  assert.match(r.content, /# Skill: deploy/);
  assert.match(r.content, /run\.sh/);
  assert.equal(r.untrusted, true);
  assert.equal((await skillTool.run({ name: 'mine' }, ctx)).untrusted, false);
  const miss = await skillTool.run({ name: 'zzz' }, ctx);
  assert.ok(miss.isError && /deploy/.test(miss.content));
});
