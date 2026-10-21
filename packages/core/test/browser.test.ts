import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserController } from '../src/browser/controller.ts';
import { ChromeFactory, findChrome } from '../src/browser/chrome.ts';
import { browserTool, resolveBrowserUrl } from '../src/tools/browser.ts';
import { PermissionPolicy } from '../src/permissions/policy.ts';
import { tempProject } from './helpers.ts';
import type { ToolContext } from '../src/tools/types.ts';

const chrome = findChrome();
const skip = chrome ? false : 'нет Chrome/Chromium (задайте CHROME_PATH)';

const INDEX = `<!doctype html><html><head><title>Todo demo</title></head><body>
<h1>Todo</h1>
<label for="t">New task</label><input id="t" placeholder="What to do">
<button id="add">Add</button>
<button id="crash">Crash</button>
<select id="prio" aria-label="Priority"><option>low</option><option>high</option></select>
<ul id="list"></ul>
<a href="/about">About us</a> <a href="http://blocked.example/x">Elsewhere</a>
<p id="status">Ready</p>
<script src="/missing.js"></script>
<script>
document.getElementById('add').onclick = () => { const v = document.getElementById('t').value; if (!v) return; const li = document.createElement('li'); li.textContent = v + ' (' + document.getElementById('prio').value + ')'; document.getElementById('list').append(li); document.getElementById('status').textContent = 'Added ' + v; };
document.getElementById('crash').onclick = () => { throw new Error('boom from handler'); };
</script></body></html>`;

let server: Server;
let base = '';
let factory: ChromeFactory;
let b: BrowserController;
let project: string;

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(INDEX);
    if (req.url === '/about') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<title>About</title><h1>About us</h1><p>We make todos.</p>');
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  project = tempProject({ 'page.html': '<title>Local</title><h1>Local page</h1><button>Go</button>', '.env': 'SECRET=1' });
  factory = await ChromeFactory.launch();
  b = new BrowserController({ factory, fileRoots: [project] });
});

after(async () => {
  await b?.dispose();
  server?.close();
});

test('open и snapshot: заголовок, текст и пронумерованные элементы', { skip }, async () => {
  const r = await b.navigate(base);
  assert.equal(r.ok, true);
  const text = await b.snapshotText();
  assert.match(text, /Page: Todo demo/);
  assert.match(text, /# Todo/);
  assert.match(text, /\[\d+\] textbox "New task" value="" placeholder="What to do"/);
  assert.match(text, /\[\d+\] button "Add"/);
  assert.match(text, /\[\d+\] select "Priority" value="low" options: low \| high/);
  assert.match(text, /\[\d+\] link "About us" -> \/about/);
  assert.match(text, /Ready/);
});

test('type и click меняют страницу, новый снимок это видит', { skip }, async () => {
  const snap = await b.snapshotText();
  const ref = (re: RegExp) => Number(re.exec(snap)![1]);
  await b.type(ref(/\[(\d+)\] textbox "New task"/), 'buy milk');
  await b.type(ref(/\[(\d+)\] select "Priority"/), 'high');
  await b.click(ref(/\[(\d+)\] button "Add"/));
  const after = await b.snapshotText();
  assert.match(after, /- buy milk \(high\)/);
  assert.match(after, /Added buy milk/);
});

test('консоль: 404 скрипта и исключение из обработчика', { skip }, async () => {
  await b.navigate(base);
  const snap = await b.snapshotText();
  assert.match(snap, /Console: \d+ new message/);
  const first = (await b.consoleLines()).join('\n');
  assert.match(first, /HTTP 404 .*missing\.js/);
  const crash = Number(/\[(\d+)\] button "Crash"/.exec(snap)![1]);
  await b.click(crash);
  const second = (await b.consoleLines()).join('\n');
  assert.match(second, /Uncaught: Error: boom from handler/);
  assert.deepEqual(await b.consoleLines(), []);
});

test('ссылка на неразрешённый домен блокируется, на тот же домен работает', { skip }, async () => {
  await b.navigate(base);
  const snap = await b.snapshotText();
  const blocked = Number(/\[(\d+)\] link "Elsewhere"/.exec(snap)![1]);
  await b.click(blocked);
  assert.match(b.activeTab!.url, new RegExp(`^${base}/?$`));
  assert.match((await b.consoleLines()).join('\n'), /Blocked navigation to http:\/\/blocked\.example\/x/);
  const about = Number(/\[(\d+)\] link "About us"/.exec(await b.snapshotText())![1]);
  await b.click(about);
  assert.match(await b.snapshotText(), /# About us/);
  const back = await b.history(-1);
  assert.equal(back.ok, true);
  assert.match(await b.snapshotText(), /# Todo/);
});

test('file:// внутри проекта открывается, вне проекта и секреты нет', { skip }, async () => {
  assert.equal(b.isAllowed(pathToFileURL(join(project, 'page.html')).href), true);
  assert.equal(b.isAllowed(pathToFileURL(join(project, '.env')).href), false);
  assert.equal(b.isAllowed('file:///etc/passwd'), false);
  assert.equal(b.isAllowed('javascript:alert(1)'), false);
  assert.equal(b.isAllowed('http://example.com'), false);
  b.allowHost('example.com');
  assert.equal(b.isAllowed('https://example.com/x'), true);
  await b.navigate(pathToFileURL(join(project, 'page.html')).href);
  assert.equal(b.isTrustedPage(), true);
  assert.match(await b.snapshotText(), /# Local page/);
  const r = await b.navigate('file:///etc/passwd');
  assert.equal(r.ok, false);
});

test('снимок экрана — настоящий JPEG', { skip }, async () => {
  await b.navigate(base);
  const s = await b.screenshot();
  assert.equal(s.mime, 'image/jpeg');
  assert.ok(s.data.length > 1000);
  assert.equal(s.data[0], 0xff);
  assert.equal(s.data[1], 0xd8);
});

test('кадры для окна: пока есть зритель, приходят JPEG', { skip }, async () => {
  const frames: number[] = [];
  const off = b.onEvent((e) => e.type === 'frame' && frames.push(e.data.length));
  await b.attachViewer();
  await b.navigate(base);
  await new Promise((r) => setTimeout(r, 600));
  await b.detachViewer();
  off();
  assert.ok(frames.length > 0, 'ни одного кадра');
});

test('инструмент browser: полный цикл с правами', { skip }, async () => {
  const ctx: ToolContext = { cwd: project, sessionId: 's', todos: [], browser: b, vision: true };
  const open = await browserTool.run({ action: 'open', url: base }, ctx);
  assert.equal(open.isError, undefined);
  assert.equal(open.untrusted, true);
  assert.match(open.content, /# Todo/);
  const local = await browserTool.run({ action: 'open', url: 'page.html' }, ctx);
  assert.match(local.content, /# Local page/);
  assert.equal(local.untrusted, false);
  const shot = await browserTool.run({ action: 'screenshot' }, ctx);
  assert.equal(shot.images?.length, 1);
  const noVision = await browserTool.run({ action: 'screenshot' }, { ...ctx, vision: false });
  assert.equal(noVision.isError, true);
  const bad = await browserTool.run({ action: 'click' }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content, /needs ref/);
  const stale = await browserTool.run({ action: 'click', ref: 99 }, ctx);
  assert.match(stale.content, /not on the page/);
});

test('resolveBrowserUrl', () => {
  const dir = tempProject({ 'index.html': '' });
  assert.equal(resolveBrowserUrl('localhost:3000/app', dir), 'http://localhost:3000/app');
  assert.equal(resolveBrowserUrl('https://example.com/a', dir), 'https://example.com/a');
  assert.equal(resolveBrowserUrl('index.html', dir), pathToFileURL(join(dir, 'index.html')).href);
  assert.equal(resolveBrowserUrl('example.com', dir), 'https://example.com');
  assert.equal(resolveBrowserUrl('javascript:alert(1)', dir), null);
  assert.equal(resolveBrowserUrl('data:text/html,hi', dir), null);
  assert.equal(resolveBrowserUrl('just some words', dir), null);
});

test('права: локальное без вопроса, чужие сайты с вопросом, режим чтения', () => {
  const dir = tempProject({ 'index.html': '' });
  const mk = (mode: 'ask' | 'read-only' | 'full' | 'auto-edit') => new PermissionPolicy({ mode, cwd: dir, sandboxEnforced: true });
  const decide = (p: PermissionPolicy, args: any) => {
    const intent = browserTool.inspect(args, { cwd: dir, sessionId: 's', todos: [] });
    return p.decide(browserTool, args, intent);
  };
  const p = mk('ask');
  assert.equal(decide(p, { action: 'open', url: 'localhost:5173' }).action, 'allow');
  assert.equal(decide(p, { action: 'open', url: 'index.html' }).action, 'allow');
  const ask = decide(p, { action: 'open', url: 'https://news.example.org/a' });
  assert.equal(ask.action, 'ask');
  assert.equal((ask as any).grantKey, 'browser:host:news.example.org');
  p.grant('browser:host:news.example.org');
  assert.equal(decide(p, { action: 'open', url: 'https://news.example.org/b' }).action, 'allow');
  assert.equal(decide(p, { action: 'open', url: 'javascript:alert(1)' }).action, 'deny');
  // абсолютный POSIX-путь вне проекта; на Windows такой путь привязан к диску и разбирается иначе
  if (process.platform !== 'win32') assert.equal(decide(p, { action: 'open', url: '/etc/hosts' }).action, 'ask');
  assert.equal(decide(p, { action: 'click', ref: 1 }).action, 'allow');
  assert.equal(decide(mk('read-only'), { action: 'click', ref: 1 }).action, 'deny');
  assert.equal(decide(mk('read-only'), { action: 'snapshot' }).action, 'allow');
  assert.equal(decide(mk('read-only'), { action: 'open', url: 'https://x.example.org' }).action, 'deny');
  assert.equal(decide(mk('full'), { action: 'open', url: 'https://x.example.org' }).action, 'allow');
  assert.equal(decide(mk('ask'), { action: 'open', url: '.env' }).action, 'deny');
});
