import { useEffect, useRef, useState } from 'react';
import { openFile } from '../actions';
import { bridge } from '../bridge';
import { setState, useStore } from '../store';

export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose(): void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // в фазе перехвата: xterm в фокусе гасит Escape, и окно иначе не закрывалось бы с клавиатуры
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog() {
  const c = useStore((s) => s.confirm);
  if (!c) return null;
  const close = () => setState({ confirm: null });
  return (
    <Modal title={c.title} onClose={close}>
      <p>{c.text}</p>
      <div className="modal-actions">
        <button className="ghost" onClick={close}>
          Отмена
        </button>
        <button className={c.danger ? 'danger-btn' : 'primary'} autoFocus onClick={() => (close(), c.run())}>
          {c.ok}
        </button>
      </div>
    </Modal>
  );
}

export function PromptDialog() {
  const p = useStore((s) => s.prompt);
  const [value, setValue] = useState('');
  useEffect(() => setValue(p?.value ?? ''), [p]);
  if (!p) return null;
  const close = () => setState({ prompt: null });
  const ok = () => value.trim() && (close(), p.run(value));
  return (
    <Modal title={p.title} onClose={close}>
      <input className="wide-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()} aria-label={p.title} />
      {p.hint && <p className="muted small-text">{p.hint}</p>}
      <div className="modal-actions">
        <button className="ghost" onClick={close}>
          Отмена
        </button>
        <button className="primary" disabled={!value.trim()} onClick={ok}>
          {p.ok}
        </button>
      </div>
    </Modal>
  );
}

/** Быстрое открытие файла по имени (⌘P / Ctrl+P). */
export function QuickOpen() {
  const open = useStore((s) => s.quickOpen);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQ('');
    setHits([]);
    setIdx(0);
  }, [open]);
  useEffect(() => {
    if (!open || !q.trim()) return setHits([]);
    const t = setTimeout(() => void bridge.call('fs.search', { query: q, mode: 'name' }).then((h) => (setHits(h.slice(0, 12).map((x) => x.path)), setIdx(0)), () => undefined), 100);
    return () => clearTimeout(t);
  }, [q, open]);
  if (!open) return null;
  const close = () => setState({ quickOpen: false });
  const choose = (p: string | undefined) => p && (close(), openFile(p));
  return (
    <Modal title="Открыть файл" onClose={close}>
      <input
        ref={input}
        className="wide-input"
        autoFocus
        value={q}
        placeholder="Имя файла"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(i + 1, hits.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0)));
          else if (e.key === 'Enter') choose(hits[idx]);
        }}
      />
      <ul className="quick-list">
        {hits.map((h, i) => (
          <li key={h} className={i === idx ? 'sel' : ''} onMouseDown={() => choose(h)}>
            {h}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
