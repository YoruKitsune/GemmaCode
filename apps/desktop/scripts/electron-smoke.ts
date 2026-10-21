// Проверка настоящего приложения: Electron запускается, главный процесс поднимает utility-процесс с сервисом агента,
// окно (file://) общается с ним по IPC. Движок подменён поддельным OpenAI-сервером.
// Запуск: ELECTRON_BIN=/путь/к/electron node --experimental-strip-types scripts/electron-smoke.ts (на Linux под xvfb-run).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startFakeServer } from '../../../packages/core/test/fixtures/fake-openai-server.ts';

const root = resolve(import.meta.dirname, '..');
const out = process.env.E2E_OUT ?? join(root, 'e2e-out');
mkdirSync(out, { recursive: true });
const bin = process.env.ELECTRON_BIN ?? (existsSync(join(root, 'node_modules/.bin/electron')) ? join(root, 'node_modules/.bin/electron') : '');
if (!bin) throw new Error('Укажите ELECTRON_BIN');

const home = mkdtempSync(join(tmpdir(), 'gc-smoke-home-'));
const project = mkdtempSync(join(tmpdir(), 'gc-smoke-proj-'));
writeFileSync(join(project, 'hello.txt'), 'привет\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });

const fake = await startFakeServer([{ call: { name: 'write_file', args: { path: 'out.txt', content: 'из окна\n' } } }, { text: 'Готово, файл создан.' }]);
mkdirSync(join(home, '.gemmacode'), { recursive: true });
writeFileSync(join(home, '.gemmacode', 'config.json'), JSON.stringify({ mode: 'auto-edit', server: { url: fake.url }, contextSize: 16384 }));
writeFileSync(join(home, '.gemmacode', 'app.json'), JSON.stringify({ recentProjects: [project], lastProject: project }));

const port = 9300 + Math.floor(Math.random() * 500);
const args = ['.', '--no-sandbox', `--remote-debugging-port=${port}`];
const app = spawn(bin, args, { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
app.stdout.on('data', (d) => (log += d));
app.stderr.on('data', (d) => (log += d));
const exited = new Promise<number | null>((r) => app.on('exit', (c) => r(c)));

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${extra}`}`);
  if (!ok) failed++;
};

try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) throw new Error(`Electron не открыл порт отладки.\n${log}`);
  const page = browser.contexts()[0]!.pages().find((p) => p.url().startsWith('file://')) ?? (await browser.contexts()[0]!.waitForEvent('page'));
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  console.log('Электрон, проверка приложения');

  await page.getByText('Новая сессия').first().waitFor({ timeout: 20000 });
  check('окно загрузилось с file://, последний проект открыт', true);
  await page.locator('.dot.ok').first().waitFor({ timeout: 15000 });
  check('сервис в utility-процессе ответил, движок подключён', true);
  check('мост IPC доступен окну (platform)', (await page.evaluate(() => typeof window.gemmacode?.platform)) === 'string');

  const box = page.getByRole('textbox').first();
  await box.fill('Создай out.txt');
  await box.press('Enter');
  await page.getByText('Готово, файл создан').waitFor({ timeout: 15000 });
  check('ход агента проходит через IPC, правка применена', readFileSync(join(project, 'out.txt'), 'utf8') === 'из окна\n');
  await page.locator('.diff-add').first().waitFor({ timeout: 5000 });
  check('diff показан в ленте', true);
  await page.screenshot({ path: join(out, '11-electron.png') });

  await page.getByRole('tab', { name: /Терминал/ }).click();
  let term = false;
  try {
    await page.locator('.xterm').waitFor({ timeout: 10000 });
    await page.locator('.xterm').click();
    await page.waitForTimeout(800);
    await page.keyboard.type('echo smoke-$((6*7))\n');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('smoke-42'), undefined, { timeout: 8000 });
    term = true;
  } catch {
    // ниже попадёт в отчёт
  }
  check('терминал (node-pty в utility-процессе)', term);
  const real = errors.filter((e) => !/Autofill|favicon/.test(e));
  check('в консоли окна нет ошибок', real.length === 0, real.join('\n'));

  app.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
  check('приложение завершается само', code !== 'timeout', String(code));
} catch (e) {
  failed++;
  console.log(`  ✗ ${(e as Error).message}`);
  app.kill('SIGKILL');
}
await fake.close();
if (failed) console.log(`\nЖурнал приложения:\n${log.slice(-2000)}`);
console.log(failed ? `\nНе прошло: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
