import type { AttachmentView, FeedItem, TurnEvent } from './types.ts';

/** Сообщение истории в том виде, как оно лежит в файле сессии (подмножество типа ядра `ChatMessage`). */
export type StoredMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user';
      content: string | { type: string; text?: string; path?: string }[];
      checkpoint?: number;
      /** Что видит пользователь: его текст без служебных вставок и список вложений. */
      ui?: { text: string; attachments: AttachmentView[] };
    }
  | { role: 'assistant'; content: string; toolCalls?: { id: string; name: string; arguments: string }[] }
  | { role: 'tool'; toolCallId: string; content: string };

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;

const ERROR_RESULT = /^(Invalid arguments|Denied|old_string|File not found|Failed|Tool crashed|Unknown tool|Browser error|Could not (?:load|open)|The site is not allowed|Screenshots are unavailable|Element \[|Directory not found|Invalid regular expression)/;

function toolItem(call: { id: string; name: string; arguments: string }): Extract<FeedItem, { kind: 'tool' }> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    // невалидные аргументы показываем пустыми
  }
  const target = call.name === 'browser' ? [args.action, args.url ?? (args.ref !== undefined ? `[${String(args.ref)}]` : '')].filter(Boolean).join(' ') : (args.path ?? args.command ?? args.pattern ?? args.name ?? '');
  return { kind: 'tool', id: call.id, name: call.name, summary: `${call.name}${target ? ` ${String(target)}` : ''}`, args, status: 'running' };
}

/** Лента чата из сохранённой истории (открытие и продолжение сессии). Подробные diff доступны через «Изменения». */
export function feedFromMessages(messages: readonly StoredMessage[]): FeedItem[] {
  const feed: FeedItem[] = [];
  const tools = new Map<string, Extract<FeedItem, { kind: 'tool' }>>();
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.ui?.text ?? (typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n'));
      if (!m.ui && /^\[Context was compacted/.test(text)) {
        feed.push({ kind: 'note', id: nid('n'), level: 'info', text: 'Контекст был сжат: старые шаги заменены краткой сводкой.' });
        continue;
      }
      if (!m.ui && /^(The check `|Review of your changes|Your reply was not valid JSON|You have tools and must use them|\[Image from the )/.test(text)) continue;
      feed.push({ kind: 'user', id: nid('u'), text: stripNotes(text), attachments: m.ui?.attachments ?? [], ...(m.checkpoint ? { checkpoint: m.checkpoint } : {}) });
    } else if (m.role === 'assistant') {
      if (m.content.trim()) feed.push({ kind: 'assistant', id: nid('a'), text: m.content });
      for (const c of m.toolCalls ?? []) {
        const item = toolItem(c);
        tools.set(c.id, item);
        feed.push(item);
      }
    } else if (m.role === 'tool') {
      const item = tools.get(m.toolCallId);
      if (!item) continue;
      item.result = m.content;
      item.status = /^Denied/.test(m.content) ? 'denied' : ERROR_RESULT.test(m.content) ? 'error' : 'ok';
    }
  }
  // вызов без результата — оборванный ход
  for (const t of tools.values()) if (t.status === 'running') t.status = 'error';
  return feed;
}

function stripNotes(text: string): string {
  return text.replace(/^\[Note: [^\]]*\]\n\n/, '');
}

/** Применяет событие хода к ленте. Возвращает новый массив, элементы без изменений сохраняют ссылки. */
export function applyTurnEvent(feed: readonly FeedItem[], ev: TurnEvent): FeedItem[] {
  const out = feed.slice();
  const last = out[out.length - 1];
  const closeStreaming = () => {
    const l = out[out.length - 1];
    if (l && l.kind === 'assistant' && l.streaming) out[out.length - 1] = { ...l, streaming: false };
  };
  switch (ev.type) {
    case 'text':
      if (last && last.kind === 'assistant' && last.streaming) out[out.length - 1] = { ...last, text: last.text + ev.delta };
      else out.push({ kind: 'assistant', id: nid('a'), text: ev.delta, streaming: true });
      return out;
    case 'reasoning':
      if (last && last.kind === 'reasoning') out[out.length - 1] = { ...last, text: last.text + ev.delta };
      else out.push({ kind: 'reasoning', id: nid('r'), text: ev.delta });
      return out;
    case 'tool_call':
      closeStreaming();
      out.push({ kind: 'tool', id: ev.id, name: ev.name, summary: ev.summary, args: ev.args, status: 'running' });
      return out;
    case 'tool_result': {
      const i = out.findIndex((x) => x.kind === 'tool' && x.id === ev.id);
      if (i < 0) return out;
      const t = out[i] as Extract<FeedItem, { kind: 'tool' }>;
      out[i] = {
        ...t,
        status: /^Denied/.test(ev.content) ? 'denied' : ev.isError ? 'error' : 'ok',
        result: ev.content,
        ms: ev.ms,
        touched: ev.touched,
        ...(ev.diff ? { diff: ev.diff } : {}),
      };
      return out;
    }
    case 'invalid_call':
      closeStreaming();
      out.push({ kind: 'note', id: nid('n'), level: 'warn', text: `Некорректный вызов ${ev.name}: ${ev.error}` });
      return out;
    case 'compaction':
      out.push({ kind: 'note', id: nid('n'), level: 'info', text: `Контекст сжат: ${ev.before} → ${ev.after} токенов.` });
      return out;
    case 'fallback':
      out.push({ kind: 'note', id: nid('n'), level: 'info', text: 'Сервер не разобрал вызов инструмента; шаг повторён в режиме строгой схемы.' });
      return out;
    case 'nudge':
      out.push({ kind: 'note', id: nid('n'), level: 'info', text: 'Модель попросила содержимое файла у пользователя; напомнил ей про инструменты чтения.' });
      return out;
    case 'verify':
      out.push({ kind: 'verify', id: nid('v'), command: ev.command, passed: ev.passed, output: ev.output, iteration: ev.iteration });
      return out;
    case 'iteration':
      if (ev.n > 1) out.push({ kind: 'note', id: nid('n'), level: 'info', text: `Попытка ${ev.n} из ${ev.max}: ${ev.reason === 'verify_failed' ? 'проверка не прошла' : 'замечания ревью'}.` });
      return out;
    case 'review':
      if (ev.verdict === 'issues') out.push({ kind: 'note', id: nid('n'), level: 'info', text: `Само-ревью нашло замечаний: ${ev.issues.length}.` });
      return out;
    case 'run_done':
      if (ev.outcome === 'no_progress') out.push({ kind: 'note', id: nid('n'), level: 'warn', text: 'Проверка по-прежнему не проходит, а агент ничего не меняет. Остановлено.' });
      else if (ev.outcome === 'max_iterations') out.push({ kind: 'note', id: nid('n'), level: 'warn', text: 'Исчерпаны попытки исправить проверку.' });
      return out;
    case 'done': {
      closeStreaming();
      // вызовы, у которых не пришёл результат (отмена посреди хода), больше не «выполняются»
      for (let i = 0; i < out.length; i++) {
        const x = out[i]!;
        if (x.kind === 'tool' && x.status === 'running') out[i] = { ...x, status: 'error', result: x.result ?? 'Прервано' };
      }
      const text = DONE_TEXT[ev.reason];
      if (text) out.push({ kind: 'note', id: nid('n'), level: ev.reason === 'error' ? 'error' : ev.reason === 'aborted' ? 'info' : 'warn', text: ev.message ? `${text}: ${ev.message}` : text });
      return out;
    }
    default:
      return out;
  }
}

const DONE_TEXT: Partial<Record<Extract<TurnEvent, { type: 'done' }>['reason'], string>> = {
  aborted: 'Остановлено',
  max_steps: 'Достигнут лимит шагов',
  invalid_tool_calls: 'Модель несколько раз подряд выдала некорректные вызовы',
  loop_detected: 'Модель зациклилась на одном вызове',
  error: 'Ошибка',
};
