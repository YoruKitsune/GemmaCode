import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, TOOLS, schemaModeSetup } from './tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const loadTasks = () => JSON.parse(readFileSync(join(here, '..', 'tasks', 'tasks.json'), 'utf8'));

const SKILLS = 'Installed skills (load with the skill tool): pdf-extract (extract text from PDF files); commit-message (write a commit message for staged changes); code-review (review a diff); changelog (update CHANGELOG.md).';
const BASE_SYSTEM = `${SYSTEM_PROMPT}\n${SKILLS}`;

function matches(m, value) {
  if (typeof value !== 'string') return false;
  if ('eq' in m) return value.trim() === m.eq;
  if ('contains' in m) return value.toLowerCase().includes(m.contains.toLowerCase());
  if ('regex' in m) return new RegExp(m.regex, 'i').test(value.trim());
  return false;
}

/** Оценка первого вызова инструмента. Возвращает {ok, reason}. */
export function score(task, got) {
  const { tool, args } = task.expect;
  if (tool === null) return got.name ? { ok: false, reason: 'extra_call' } : { ok: true, reason: 'ok' };
  if (!got.name) return { ok: false, reason: 'no_call' };
  if (got.name !== tool) return { ok: false, reason: 'wrong_tool' };
  let parsed;
  try {
    parsed = typeof got.arguments === 'string' ? JSON.parse(got.arguments) : got.arguments;
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'bad_json' };
  for (const [k, m] of Object.entries(args)) {
    if (!matches(m, parsed[k])) return { ok: false, reason: `bad_args:${k}` };
  }
  return { ok: true, reason: 'ok' };
}

async function ask(baseUrl, body, model) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(model ? { model } : {}), temperature: 0, max_tokens: 512, ...body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Режим native: инструменты передаются через tools, парсит llama-server (--jinja). */
async function runNative(baseUrl, task, model) {
  const j = await ask(baseUrl, { messages: [{ role: 'system', content: BASE_SYSTEM }, ...task.messages], tools: TOOLS, cache_prompt: true }, model);
  const msg = j.choices?.[0]?.message ?? {};
  const tc = msg.tool_calls?.[0]?.function;
  return { name: tc?.name ?? null, arguments: tc?.arguments ?? null, text: msg.content ?? '', timings: j.timings };
}

/** Режим schema: ответ ограничен JSON-схемой, то есть невалидный вызов невозможен. */
async function runSchema(baseUrl, task, model) {
  const { schema, system } = schemaModeSetup(TOOLS);
  const messages = [{ role: 'system', content: `${system}\n${SKILLS}` }, ...task.messages.map(flattenForSchema)];
  const j = await ask(baseUrl, { messages, response_format: { type: 'json_schema', json_schema: { name: 'call', schema } }, cache_prompt: true }, model);
  const text = j.choices?.[0]?.message?.content ?? '';
  try {
    const o = JSON.parse(text);
    return { name: o.tool === 'reply' ? null : o.tool, arguments: JSON.stringify(o.arguments ?? {}), text, timings: j.timings };
  } catch {
    return { name: null, arguments: null, text, timings: j.timings, parseFailed: true };
  }
}

// В режиме schema история хранится текстом: assistant-вызов как JSON, результат как сообщение пользователя.
function flattenForSchema(m) {
  if (m.role === 'assistant' && m.tool_calls) {
    const f = m.tool_calls[0].function;
    return { role: 'assistant', content: JSON.stringify({ tool: f.name, arguments: JSON.parse(f.arguments) }) };
  }
  if (m.role === 'tool') return { role: 'user', content: `Tool result:\n${m.content}` };
  return m;
}

export async function runToolEval(baseUrl, { mode = 'native', limit, model, log = console.log } = {}) {
  const tasks = loadTasks().slice(0, limit ?? undefined);
  const run = mode === 'schema' ? runSchema : runNative;
  const rows = [];
  const t0 = Date.now();
  for (const [i, task] of tasks.entries()) {
    let got;
    try {
      got = await run(baseUrl, task, model);
    } catch (e) {
      got = { name: null, arguments: null, text: `ERROR ${e.message}`, error: true };
    }
    const s = score(task, got);
    rows.push({ id: task.id, category: task.category, ok: s.ok, reason: s.reason, got: { name: got.name, arguments: got.arguments, text: (got.text ?? '').slice(0, 200) } });
    if ((i + 1) % 10 === 0) log(`    ${i + 1}/${tasks.length}, верно ${rows.filter((r) => r.ok).length}`);
  }
  const byCategory = {};
  for (const r of rows) {
    const c = (byCategory[r.category] ??= { n: 0, ok: 0 });
    c.n++;
    if (r.ok) c.ok++;
  }
  const reasons = {};
  for (const r of rows.filter((r) => !r.ok)) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return { mode, n: rows.length, ok: rows.filter((r) => r.ok).length, rate: rows.filter((r) => r.ok).length / rows.length, seconds: (Date.now() - t0) / 1000, byCategory, reasons, rows };
}
