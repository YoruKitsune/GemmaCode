import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentView, FeedItem } from '@gemmacode/protocol';
import { confirmRollback, openFile } from '../actions';
import { bridge } from '../bridge';
import { formatDuration } from '../format';
import { renderMarkdown } from '../markdown';
import { getState, useStore } from '../store';
import { DiffView } from './DiffView';
import { IconAudio, IconCheck, IconChevron, IconClose, IconFile, IconImage, IconUndo, Spinner } from './icons';

const thumbCache = new Map<string, string>();

function useThumb(path: string | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(path ? thumbCache.get(path) : undefined);
  useEffect(() => {
    if (!path || thumbCache.has(path)) return;
    let alive = true;
    bridge.call('fs.read', { path }).then(
      (f) => {
        if (f.kind !== 'image') return;
        thumbCache.set(path, f.dataUrl);
        if (alive) setUrl(f.dataUrl);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}

function AttachmentChip({ a }: { a: AttachmentView }) {
  const thumb = useThumb(a.kind === 'image' ? a.relPaths[0] : undefined);
  return (
    <span className="att-chip" title={a.note ?? a.name} onClick={() => a.kind !== 'image' && a.relPaths[0] && openFile(a.relPaths[0])}>
      {thumb ? <img src={thumb} alt={a.name} /> : a.kind === 'image' ? <IconImage /> : a.kind === 'audio' ? <IconAudio /> : <IconFile />}
      <span className="att-name">{a.name}</span>
      {a.note && <span className="att-note">{a.note}</span>}
    </span>
  );
}

const UserMessage = memo(function UserMessage({ item, canRollback, onRollback }: { item: Extract<FeedItem, { kind: 'user' }>; canRollback: boolean; onRollback(): void }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">
        {item.attachments.length > 0 && (
          <div className="att-row">
            {item.attachments.map((a, i) => (
              <AttachmentChip key={i} a={a} />
            ))}
          </div>
        )}
        {item.text && <div className="user-text">{item.text}</div>}
      </div>
      {canRollback && (
        <button className="ghost small rollback" onClick={onRollback} title="Вернуть файлы и историю к состоянию до этого сообщения">
          <IconUndo size={13} /> Откатить к этому ходу
        </button>
      )}
    </div>
  );
});

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.dataset.copy !== undefined) {
          const code = t.closest('.code')?.querySelector('code')?.textContent ?? '';
          void navigator.clipboard?.writeText(code);
          t.textContent = 'Скопировано';
          setTimeout(() => (t.textContent = 'Копировать'), 1500);
        }
        const a = t.closest('a');
        if (a?.dataset.ext !== undefined) {
          e.preventDefault();
          bridge.openExternal(a.getAttribute('href') ?? '');
        }
      }}
    />
  );
}

const AssistantMessage = memo(function AssistantMessage({ item }: { item: Extract<FeedItem, { kind: 'assistant' }> }) {
  return (
    <div className={`msg msg-assistant${item.streaming ? ' streaming' : ''}`}>
      <Markdown text={item.text} />
    </div>
  );
});

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

const ToolCard = memo(function ToolCard({ item }: { item: Extract<FeedItem, { kind: 'tool' }> }) {
  const hasDiff = Boolean(item.diff);
  const [open, setOpen] = useState(hasDiff && WRITE_TOOLS.has(item.name));
  // diff приходит вместе с результатом, уже после появления карточки
  useEffect(() => {
    if (hasDiff && WRITE_TOOLS.has(item.name)) setOpen(true);
  }, [hasDiff, item.name]);
  const body = item.result ?? '';
  const shell = item.name === 'shell';
  const path = typeof item.args.path === 'string' ? item.args.path : undefined;
  return (
    <div className={`tool tool-${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`chev${open ? ' open' : ''}`}>
          <IconChevron size={12} />
        </span>
        <span className="tool-state">
          {item.status === 'running' ? <Spinner size={12} /> : item.status === 'ok' ? <IconCheck size={13} /> : <IconClose size={13} />}
        </span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{item.summary.replace(new RegExp(`^${item.name}\\s*`), '')}</span>
        {item.status === 'denied' && <span className="tag">отклонено</span>}
        {item.ms !== undefined && item.ms > 50 && <span className="tool-ms">{formatDuration(item.ms)}</span>}
      </button>
      {open && (
        <div className="tool-body">
          {shell && typeof item.args.command === 'string' && <pre className="cmd">$ {item.args.command}</pre>}
          {hasDiff ? <DiffView diff={item.diff!} /> : body ? <ResultText text={body} /> : <div className="muted">Нет вывода</div>}
          {hasDiff && path && (
            <button className="ghost small" onClick={() => openFile(path)}>
              Открыть файл
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function ResultText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const cut = !all && text.length > 4000;
  return (
    <>
      <pre className="result">{cut ? text.slice(0, 4000) : text}</pre>
      {cut && (
        <button className="ghost small" onClick={() => setAll(true)}>
          Показать целиком ({text.length} симв.)
        </button>
      )}
    </>
  );
}

function Reasoning({ item }: { item: Extract<FeedItem, { kind: 'reasoning' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button className="ghost small" onClick={() => setOpen(!open)}>
        Рассуждения {open ? '▾' : '▸'}
      </button>
      {open && <pre className="result">{item.text}</pre>}
    </div>
  );
}

function VerifyCard({ item }: { item: Extract<FeedItem, { kind: 'verify' }> }) {
  const [open, setOpen] = useState(!item.passed);
  return (
    <div className={`tool ${item.passed ? 'tool-ok' : 'tool-error'}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`chev${open ? ' open' : ''}`}>
          <IconChevron size={12} />
        </span>
        <span className="tool-state">{item.passed ? <IconCheck size={13} /> : <IconClose size={13} />}</span>
        <span className="tool-name">проверка</span>
        <span className="tool-summary">{item.command}</span>
        <span className="tag">{item.passed ? 'пройдена' : 'не пройдена'}</span>
      </button>
      {open && <pre className="result">{item.output || '(нет вывода)'}</pre>}
    </div>
  );
}

export function Feed() {
  const feed = useStore((s) => s.session?.feed);
  const running = useStore((s) => s.session?.running ?? false);
  const checkpoints = useStore((s) => s.session?.checkpoints);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const known = useMemo(() => new Set(checkpoints?.map((c) => c.id)), [checkpoints]);

  if (!feed) return <div className="feed" />;
  return (
    <div
      className="feed"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="feed-inner">
        {feed.length === 0 && <EmptyState />}
        {feed.map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <UserMessage
                  key={item.id}
                  item={item}
                  canRollback={!running && item.checkpoint !== undefined && known.has(item.checkpoint)}
                  onRollback={() => item.checkpoint !== undefined && confirmRollback(item.checkpoint, (item.text || 'вложение').slice(0, 60))}
                />
              );
            case 'assistant':
              return <AssistantMessage key={item.id} item={item} />;
            case 'reasoning':
              return <Reasoning key={item.id} item={item} />;
            case 'tool':
              return <ToolCard key={item.id} item={item} />;
            case 'verify':
              return <VerifyCard key={item.id} item={item} />;
            case 'note':
              return (
                <div key={item.id} className={`note note-${item.level}`}>
                  {item.text}
                </div>
              );
          }
        })}
        {running && feed[feed.length - 1]?.kind === 'user' && (
          <div className="thinking">
            <Spinner size={12} /> Думаю…
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  const project = useStore((s) => s.project);
  const backend = useStore((s) => s.backend);
  return (
    <div className="empty">
      <h2>{project?.name}</h2>
      <p className="muted">Опишите задачу. Агент читает и правит файлы проекта, запускает команды и показывает каждое действие в ленте. Файлы и фото можно перетащить в поле ввода.</p>
      {backend.status !== 'ready' && <p className="muted">Модель: {backend.status === 'starting' ? 'запускается…' : backend.message ?? 'не запущена'}</p>}
      {getState().project?.sandbox === 'none' && <p className="muted">Песочницы ОС нет, поэтому каждая команда потребует подтверждения.</p>}
    </div>
  );
}
