#!/usr/bin/env node
// Заглушка llama-server для проверки самого стенда без модели:
//   node bench/bench.mjs speed --bin bench/test/mock-llama-server.mjs ...
// Принимает те же флаги (нужны только --port и -hff), отдаёт правдоподобные ответы и тайминги.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
if (argv.includes('--version')) {
  console.error('version: mock (b0-mock)');
  process.exit(0);
}
const port = Number(flag('--port'));
const file = flag('-hff') ?? flag('-m')?.split('/').pop() ?? 'mock.gguf';
const tasks = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tasks', 'tasks.json'), 'utf8'));

function oracle(msgs) {
  const sig = JSON.stringify(msgs.filter((m) => m.role !== 'system').map((m) => (m.role === 'user' ? m.content : m.role)));
  const task = tasks.find((t) => JSON.stringify(t.messages.map((m) => (m.role === 'user' ? m.content : m.role))) === sig);
  if (!task) return { text: 'ok' };
  if (task.expect.tool === null) return { text: 'Just an answer.' };
  const args = {};
  for (const [k, m] of Object.entries(task.expect.args)) {
    if ('eq' in m) args[k] = m.eq;
    else if ('contains' in m) args[k] = m.contains;
    else return { tool: 'shell', args: { command: 'echo unknown' } }; // регулярки не инвертируем: намеренный промах
  }
  return { tool: task.expect.tool, args };
}

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(JSON.parse(b || '{}'))); });

createServer(async (req, res) => {
  if (req.url === '/health') return res.end('{"status":"ok"}');
  if (req.url === '/props') return res.end(JSON.stringify({ model_path: `/cache/${file}`, modalities: { vision: true, audio: true } }));
  if (req.url === '/v1/chat/completions') {
    const body = await readBody(req);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const n = Math.min(body.max_tokens ?? 64, 200);
      for (let i = 0; i < n; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `w${i} ` } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 2));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 100, cache_n: 0, prompt_per_second: 300, predicted_n: n, predicted_per_second: 45.5 }, usage: { completion_tokens: n } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    const o = oracle(body.messages);
    const schema = Boolean(body.response_format);
    let message;
    if (schema) message = { content: JSON.stringify(o.tool ? { tool: o.tool, arguments: o.args } : { tool: 'reply', arguments: { text: o.text } }) };
    else if (o.tool) message = { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: o.tool, arguments: JSON.stringify(o.args) } }] };
    else message = { content: o.text };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message }], timings: { predicted_per_second: 40 } }));
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1');
