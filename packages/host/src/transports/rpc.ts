import type { MethodName, WireMessage, WireRequest } from '@gemmacode/protocol';
import type { AgentHost } from '../host.ts';

/**
 * Связывает сервис с любым транспортом: запросы окна превращаются в вызовы методов, события сервиса уходят окну.
 * Возвращает обработчик входящих запросов и функцию отписки.
 */
export function bindHost(host: AgentHost, send: (m: WireMessage) => void): { handle(req: WireRequest): void; dispose(): void } {
  const off = host.onEvent((event, data) => send({ event, data }));
  return {
    handle(req) {
      host.call(req.method as MethodName, req.params as never).then(
        (result) => send({ id: req.id, result: result ?? null }),
        (err: unknown) => send({ id: req.id, error: { message: err instanceof Error ? err.message : String(err) } }),
      );
    },
    dispose: off,
  };
}

export function isRequest(m: unknown): m is WireRequest {
  return typeof m === 'object' && m !== null && 'method' in m && 'id' in m;
}
