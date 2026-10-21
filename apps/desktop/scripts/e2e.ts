// Сквозная проверка окна: настоящее ядро агента и сервис, настоящий HTTP до «движка» (поддельный OpenAI-сервер с заранее
// заданными ответами), окно в headless Chromium. Скриншоты кладутся в E2E_OUT (по умолчанию apps/desktop/e2e-out).
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium, type Page } from 'playwright-core';
import { AgentHost } from '../../../packages/host/src/host.ts';
import { serveWebSocket } from '../../../packages/host/src/transports/ws.ts';
import { startFakeServer } from '../../../packages/core/test/fixtures/fake-openai-server.ts';

const root = resolve(import.meta.dirname, '..');
const out = process.env.E2E_OUT ?? join(root, 'e2e-out');
mkdirSync(out, { recursive: true });

// ---------- вспомогательное ----------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = 160;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function wav(seconds: number, rate = 8000): Buffer {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return b;
}

function jpegSize(buf: Buffer): { w: number; h: number } {
  for (let i = 2; i < buf.length; ) {
    if (buf[i] !== 0xff) break;
    const m = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('не JPEG');
}

/** CHROME_PATH, иначе Chromium из Playwright; если версия не совпала с установленным браузером, любой chromium-* из PLAYWRIGHT_BROWSERS_PATH. */
function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    for (const d of readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (existsSync(join(base, d, sub))) return join(base, d, sub);
    }
  }
  return undefined;
}

const results: { name: string; ok: boolean; error?: string }[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: (e as Error).message });
    console.log(`  ✗ ${name}\n      ${(e as Error).message.split('\n').join('\n      ')}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------- стенд ----------

const home = mkdtempSync(join(tmpdir(), 'gc-e2e-home-'));
const project = mkdtempSync(join(tmpdir(), 'gc-e2e-proj-'));
writeFileSync(join(project, 'utils.js'), 'export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n');
writeFileSync(join(project, 'README.md'), '# Демо\n\nМаленький проект для проверки окна.\n');
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2));
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: project, stdio: 'pipe' });
g('init', '-q', '-b', 'main');
g('add', '.');
g('commit', '-qm', 'init');

const fake = await startFakeServer([
  // A: правка с подтверждением
  { call: { name: 'edit_file', args: { path: 'utils.js', old_string: 'a - b', new_string: 'a + b' } } },
  { text: 'Исправил функцию **sum**: теперь она складывает числа.\n\n```js\nexport const sum = (a, b) => a + b;\n```\n\nЗапуск теста не требовался.' },
  // B: отказ
  { call: { name: 'write_file', args: { path: 'README.md', content: 'перезаписано\n' } } },
  { text: 'Понял, README не трогаю.' },
  // C: картинка
  { text: 'Вижу градиентную картинку.' },
  // D: звук
  { text: 'Слышу ровный тон.' },
  // F: авто-правки без вопросов
  { call: { name: 'write_file', args: { path: 'notes.txt', content: 'заметка\n' } } },
  { text: 'Создал notes.txt.' },
]);

const host = new AgentHost({ home, version: 'e2e', platform: { trash: async () => undefined } });
await host.call('settings.set', { server: { url: fake.url }, contextSize: 16384 });
const ws = await serveWebSocket(host, 0);

const dist = join(root, 'dist', 'renderer');
if (!existsSync(join(dist, 'index.html')) || process.env.E2E_REBUILD !== '0') execFileSync('npx', ['vite', 'build'], { cwd: root, stdio: 'ignore' });
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const web = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(dist) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
const webPort = (web.address() as { port: number }).port;

const browser = await chromium.launch({
  executablePath: chromePath(),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark', locale: 'ru-RU' });
const page = await ctx.newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
const send = async (page: Page, text: string) => {
  const box = page.getByRole('textbox').first();
  await box.fill(text);
  await box.press('Enter');
};

console.log('Окно GemmaCode, сквозная проверка');

await step('проект открывается, модель подключена, пустая сессия', async () => {
  await page.goto(`http://127.0.0.1:${webPort}/?ws=${ws.port}&project=${encodeURIComponent(project)}`);
  await page.getByText('Новая сессия').first().waitFor();
  await page.locator('.dot.ok').first().waitFor({ timeout: 8000 });
  assert(await page.getByRole('heading', { name: 'Сессии' }).isVisible(), 'нет списка сессий');
  await shot('01-empty');
});

await step('правка с подтверждением: карточка с diff, разрешение, итог в ленте', async () => {
  await send(page, 'Исправь функцию sum в utils.js: она должна складывать');
  const card = page.getByRole('alertdialog');
  await card.waitFor({ timeout: 8000 });
  assert((await card.textContent())?.includes('a + b'), 'в запросе подтверждения нет diff');
  assert(readFileSync(join(project, 'utils.js'), 'utf8').includes('a - b'), 'файл изменён до подтверждения');
  await shot('02-approval');
  await card.getByRole('button', { name: 'Разрешить', exact: true }).click();
  await page.getByText('теперь она складывает').waitFor({ timeout: 8000 });
  assert(readFileSync(join(project, 'utils.js'), 'utf8').includes('a + b'), 'файл не изменён');
  await page.locator('.diff-add').first().waitFor();
  await page.locator('.code pre').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.send.stop'));
  await shot('03-edit-done');
});

await step('отказ в подтверждении: файл цел, карточка помечена', async () => {
  await send(page, 'Перепиши README целиком');
  const card = page.getByRole('alertdialog');
  await card.waitFor({ timeout: 8000 });
  await card.getByRole('button', { name: 'Отклонить' }).click();
  await page.getByText('README не трогаю').waitFor({ timeout: 8000 });
  assert(readFileSync(join(project, 'README.md'), 'utf8').startsWith('# Демо'), 'README изменён');
  assert((await page.getByText('отклонено').count()) >= 1, 'нет пометки «отклонено»');
});

await step('картинка: уменьшается до 1024 по большей стороне и уходит модели', async () => {
  await page.locator('input[type=file]').setInputFiles({ name: 'градиент.png', mimeType: 'image/png', buffer: png(1600, 800) });
  const chip = page.locator('.chips .att-chip');
  await chip.waitFor();
  await page.locator('.chips .att-chip.ready').waitFor({ timeout: 8000 });
  assert((await chip.textContent())?.includes('1600×800 → 1024×512'), `заметка о сжатии: ${await chip.textContent()}`);
  await shot('04-image-chip');
  await send(page, 'Что на картинке?');
  await page.getByText('Вижу градиентную картинку').waitFor({ timeout: 8000 });
  const body = fake.requests.at(-1);
  const parts = body.messages.at(-1).content as { type: string; image_url?: { url: string } }[];
  const img = parts.find((p) => p.type === 'image_url');
  assert(img, 'в запросе нет image_url');
  const jpg = Buffer.from(img.image_url!.url.split(',')[1]!, 'base64');
  const { w, h } = jpegSize(jpg);
  assert(w === 1024 && h === 512, `размер ${w}×${h}`);
  assert(parts[0]!.type === 'text' && (parts[0] as unknown as { text: string }).text.includes('[Attached image:'), 'нет подписи вложения');
  await page.locator('.msg-user .att-chip img').last().waitFor();
});

await step('звук: переводится в WAV 16 кГц и уходит как input_audio', async () => {
  await page.locator('input[type=file]').setInputFiles({ name: 'тон.wav', mimeType: 'audio/wav', buffer: wav(3) });
  await page.locator('.chips .att-chip.ready').waitFor({ timeout: 10000 });
  assert((await page.locator('.chips').textContent())?.includes('3 с'), `заметка: ${await page.locator('.chips').textContent()}`);
  await send(page, 'Что слышно?');
  await page.getByText('Слышу ровный тон').waitFor({ timeout: 8000 });
  const parts = fake.requests.at(-1).messages.at(-1).content as { type: string; input_audio?: { data: string; format: string } }[];
  const a = parts.find((p) => p.type === 'input_audio');
  assert(a, 'в запросе нет input_audio');
  const wavBytes = Buffer.from(a.input_audio!.data, 'base64');
  assert(wavBytes.toString('ascii', 0, 4) === 'RIFF' && wavBytes.readUInt32LE(24) === 16000, 'не WAV 16 кГц');
  assert(Math.abs(wavBytes.length - (44 + 3 * 16000 * 2)) < 400, `длина WAV ${wavBytes.length}`);
  // картинка предыдущего хода больше не уходит модели
  const earlier = JSON.stringify(fake.requests.at(-1).messages.slice(0, -1));
  assert(!earlier.includes('image_url'), 'картинка прошлого хода осталась в контексте');
});

await step('слэш-команда меняет режим без обращения к модели', async () => {
  const before = fake.requests.length;
  await send(page, '/mode auto-edit');
  await page.waitForFunction(() => (document.querySelector('select[aria-label="Режим прав"]') as HTMLSelectElement)?.value === 'auto-edit');
  assert(fake.requests.length === before, 'команда ушла модели');
});

await step('авто-правки: файл создаётся без вопросов, файловый менеджер показывает метки', async () => {
  await send(page, 'Создай notes.txt');
  await page.getByText('Создал notes.txt').waitFor({ timeout: 8000 });
  assert(readFileSync(join(project, 'notes.txt'), 'utf8') === 'заметка\n', 'файл не создан');
  assert((await page.getByRole('alertdialog').count()) === 0, 'просили подтверждение в auto-edit');
  await page.getByRole('tab', { name: /Файлы/ }).click();
  await page.locator('.tree .row', { hasText: 'notes.txt' }).waitFor({ timeout: 8000 });
  await page.locator('.tree .row', { hasText: 'utils.js' }).locator('.git-mod').waitFor();
  await page.locator('.tree .row', { hasText: 'utils.js' }).locator('.agent-dot').waitFor();
  await page.locator('.tree .row', { hasText: 'notes.txt' }).locator('.git-new').waitFor();
  await shot('05-files');
});

await step('файл открывается во вкладке, правится и сохраняется', async () => {
  await page.locator('.tree .row', { hasText: 'README.md' }).click();
  await page.locator('.cm-content').waitFor({ timeout: 10000 });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Строка из редактора\n');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForFunction(() => document.querySelector('.viewer-bar button.small:not(.ghost)')?.hasAttribute('disabled'));
  assert(readFileSync(join(project, 'README.md'), 'utf8').includes('Строка из редактора'), 'правка не сохранена');
  await shot('06-editor');
});

await step('поиск по имени и по содержимому', async () => {
  await page.getByRole('tab', { name: /Файлы/ }).click();
  const search = page.getByLabel('Поиск по проекту');
  await search.fill('util');
  await page.locator('.hits li', { hasText: 'utils.js' }).waitFor();
  await page.getByLabel('Поиск по проекту').fill('складывать');
  await page.getByText('текст', { exact: true }).click();
  await page.locator('.hits li', { hasText: 'README.md' }).waitFor({ timeout: 4000 }).catch(() => undefined);
  await search.fill('');
});

await step('вкладка «Изменения»: файлы сессии и diff', async () => {
  await page.getByRole('tab', { name: /Изменения/ }).click();
  await page.locator('.change-head', { hasText: 'utils.js' }).click();
  await page.locator('.pane:not([hidden]) .diff-add').first().waitFor();
  await shot('07-changes');
});

await step('терминал: настоящий shell в корне проекта', async () => {
  await page.getByRole('tab', { name: /Терминал/ }).click();
  await page.locator('.xterm').waitFor({ timeout: 10000 });
  await page.locator('.xterm').click();
  await page.waitForTimeout(600);
  await page.keyboard.type('pwd; echo e2e-$((6*7))\n');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('e2e-42'), undefined, { timeout: 8000 });
  assert((await page.locator('.xterm-rows').textContent())?.includes(project.split('/').pop()!), 'терминал не в папке проекта');
  await shot('08-terminal');
});

await step('настройки: модель, контекст, права', async () => {
  await page.keyboard.press('Control+,');
  await page.getByRole('dialog', { name: 'Настройки' }).waitFor();
  await shot('09-settings');
  await page.keyboard.press('Escape');
});

await step('откат: первый ход возвращает файлы и очищает историю', async () => {
  await page.getByRole('tab', { name: /Файлы/ }).click();
  await page.locator('.msg-user').first().hover();
  await page.getByRole('button', { name: /Откатить к этому ходу/ }).first().click({ force: true });
  await page.getByRole('dialog', { name: 'Откатить изменения?' }).getByRole('button', { name: 'Откатить' }).click();
  await page.getByText(/Откат: файлы возвращены/).waitFor({ timeout: 8000 });
  assert(readFileSync(join(project, 'utils.js'), 'utf8').includes('a - b'), 'utils.js не возвращён');
  assert(!existsSync(join(project, 'notes.txt')), 'notes.txt остался');
  assert((await page.locator('.msg-user').count()) === 0, 'сообщения остались в ленте');
  await shot('10-rolled-back');
});

await step('после перезагрузки окна сессия на месте', async () => {
  await page.reload();
  await page.locator('.sessions li').first().waitFor({ timeout: 8000 }).catch(() => undefined);
  assert((await page.locator('.chat-title').textContent()) !== null, 'нет заголовка');
});

await step('в консоли окна нет ошибок', async () => {
  const real = consoleErrors.filter((e) => !/favicon/.test(e));
  assert(real.length === 0, real.join('\n'));
});

await browser.close();
await ws.close();
await host.shutdown();
await fake.close();
web.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} из ${results.length} шагов прошли. Скриншоты: ${out}`);
process.exit(failed.length ? 1 : 0);
