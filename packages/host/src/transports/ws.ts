import { WebSocketServer } from 'ws';
import type { AgentHost } from '../host.ts';
import { bindHost, isRequest } from './rpc.ts';

/**
 * WebSocket-транспорт для разработки и проверок: окно открывается в обычном браузере и говорит с настоящим сервисом агента.
 * Слушает только 127.0.0.1. В приложении не используется (там IPC Electron).
 */
export function serveWebSocket(host: AgentHost, port: number): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    wss.on('error', reject);
    wss.on('connection', (ws) => {
      const bound = bindHost(host, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
      ws.on('message', (raw) => {
        try {
          const msg: unknown = JSON.parse(String(raw));
          if (isRequest(msg)) bound.handle(msg);
        } catch {
          // мусор в сокете игнорируем
        }
      });
      ws.on('close', bound.dispose);
    });
    wss.on('listening', () => {
      const addr = wss.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => new Promise((r) => wss.close(() => r())),
      });
    });
  });
}
