import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeTurn =
  | { text: string }
  | { call: { name: string; args: unknown } }
  | { calls: { name: string; args: unknown }[] }
  | ((body: any) => { text: string } | { call: { name: string; args: unknown } });

/** Минимальный OpenAI-совместимый сервер: те же SSE-дельты, что отдаёт llama-server (имя вызова и аргументы приходят кусками). */
export async function startFakeServer(script: FakeTurn[]): Promise<{ url: string; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  let i = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === '/health') return void res.end('{"status":"ok"}');
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const entry = script[i++];
      const turn = typeof entry === 'function' ? entry(body) : entry;
      if (!turn) return void res.writeHead(500).end('script exhausted');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if ('text' in turn) {
        const mid = Math.max(1, Math.floor(turn.text.length / 2));
        send({ choices: [{ delta: { content: turn.text.slice(0, mid) } }] });
        send({ choices: [{ delta: { content: turn.text.slice(mid) } }] });
      } else {
        const calls = 'calls' in turn ? turn.calls : [turn.call];
        for (const [n, c] of calls.entries()) {
          const args = JSON.stringify(c.args);
          const cut = Math.floor(args.length / 2);
          send({ choices: [{ delta: { tool_calls: [{ index: n, id: `call_${i}_${n}`, type: 'function', function: { name: c.name, arguments: '' } }] } }] });
          send({ choices: [{ delta: { tool_calls: [{ index: n, function: { arguments: args.slice(0, cut) } }] } }] });
          send({ choices: [{ delta: { tool_calls: [{ index: n, function: { arguments: args.slice(cut) } }] } }] });
        }
      }
      send({ choices: [{ delta: {}, finish_reason: 'text' in turn ? 'stop' : 'tool_calls' }], timings: { prompt_n: 120, cache_n: 30, prompt_per_second: 250, predicted_n: 20, predicted_per_second: 21.5, draft_n: 16, draft_n_accepted: 12 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
