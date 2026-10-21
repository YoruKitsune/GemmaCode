import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { AttachmentRef, CommandInfo, PermissionMode } from '@gemmacode/protocol';
import { abort, confirmRollback, newSession, sendMessage, setMode, setVerify, showTab } from '../actions';
import { bridge } from '../bridge';
import { formatTokens } from '../format';
import { dataUrlToBlob, prepareAny } from '../media';
import { composerBus } from '../events';
import { getState, toast, useStore } from '../store';
import { IconAudio, IconClip, IconClose, IconFile, IconImage, IconSend, IconStop, Spinner } from './icons';

interface Chip {
  key: number;
  name: string;
  status: 'processing' | 'ready' | 'error';
  ref?: AttachmentRef;
  preview?: string;
  kind?: string;
  error?: string;
}

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'read-only', label: 'Только чтение', hint: 'Агент читает и ищет, ничего не меняет' },
  { id: 'ask', label: 'Спрашивать', hint: 'Каждая правка и команда требует подтверждения' },
  { id: 'auto-edit', label: 'Авто-правки', hint: 'Правки в проекте без вопросов, команды по подтверждению' },
  { id: 'full', label: 'Полный доступ', hint: 'Всё без вопросов; песочница ОС остаётся' },
];

let chipKey = 0;

export function Composer() {
  const session = useStore((s) => s.session);
  const backend = useStore((s) => s.backend);
  const commands = useStore((s) => s.commands);
  const speed = useStore((s) => s.speed);
  const info = useStore((s) => s.info);
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [drag, setDrag] = useState(false);
  const [popup, setPopup] = useState<{ kind: 'slash' | 'mention'; items: { label: string; hint?: string; run(): void }[]; index: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = session?.running ?? false;

  // авто-высота поля ввода
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    area.current?.focus();
  }, [session?.id]);

  const addPrepared = useCallback(async (file: Blob, name: string) => {
    const key = ++chipKey;
    setChips((c) => [...c, { key, name, status: 'processing' }]);
    try {
      const p = await prepareAny(file, name);
      const ref = await bridge.call('attachment.save', {
        name: p.name,
        mime: p.mime,
        kind: p.kind,
        parts: p.parts,
        ...(p.note ? { note: p.note } : {}),
        ...(p.kind === 'image' || p.kind === 'audio' ? { estTokens: p.estTokens } : {}),
      });
      setChips((c) => c.map((x) => (x.key === key ? { ...x, status: 'ready', ref, ...(p.preview ? { preview: p.preview } : {}), kind: p.kind } : x)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setChips((c) => c.filter((x) => x.key !== key));
      toast(msg, 'error');
    }
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const f of Array.from(files)) void addPrepared(f, f.name || 'вставка.png');
    },
    [addPrepared],
  );

  const addProjectFile = useCallback(
    async (path: string) => {
      const name = path.split('/').pop() ?? path;
      try {
        if (/\.(png|jpe?g|webp|gif|bmp|wav|mp3|m4a|ogg|flac|aac)$/i.test(name)) {
          const f = await bridge.call('fs.read', { path });
          if (f.kind === 'image' || f.kind === 'audio') return void (await addPrepared(dataUrlToBlob(f.dataUrl), name));
        }
        const ref = await bridge.call('attachment.fromProject', { path });
        setChips((c) => [...c, { key: ++chipKey, name: ref.name, status: 'ready', ref, kind: ref.kind }]);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
    [addPrepared],
  );

  useEffect(() => {
    const onAttach = (e: Event) => void addProjectFile((e as CustomEvent<string>).detail);
    composerBus.addEventListener('attach', onAttach);
    return () => composerBus.removeEventListener('attach', onAttach);
  }, [addProjectFile]);

  const ready = chips.filter((c) => c.status === 'ready' && c.ref).map((c) => c.ref!);
  const busyChips = chips.some((c) => c.status === 'processing');
  const attachTokens = ready.reduce((n, a) => n + a.estTokens, 0);
  const canSend = Boolean(session) && !running && !busyChips && (text.trim().length > 0 || ready.length > 0);

  const runSlash = useCallback(
    async (line: string): Promise<boolean> => {
      const m = /^\/(\S+)\s*(.*)$/s.exec(line.trim());
      if (!m) return false;
      const [, name = '', arg = ''] = m;
      const s = getState().session;
      switch (name) {
        case 'mode': {
          const mode = MODES.find((x) => x.id === arg.trim());
          if (!mode) toast(`Режимы: ${MODES.map((x) => x.id).join(', ')}`);
          else await setMode(mode.id);
          return true;
        }
        case 'verify':
          await setVerify(arg.trim() === 'off' || !arg.trim() ? null : arg.trim());
          return true;
        case 'undo': {
          const cp = s?.checkpoints.at(-1);
          if (cp) confirmRollback(cp.id, cp.label);
          else toast('Откатывать нечего');
          return true;
        }
        case 'diff':
          showTab('changes');
          return true;
        case 'new':
          await newSession();
          return true;
        case 'context': {
          const c = s?.context;
          toast(c ? `Контекст: ~${c.used} из ${c.limit} токенов (${Math.round((c.used / c.limit) * 100)}%)` : 'Нет сессии');
          return true;
        }
        default:
          return false; // скилл или обычный текст: уходит агенту как есть
      }
    },
    [],
  );

  const submit = useCallback(async () => {
    const t = text.trim();
    if (!canSend) return;
    if (t.startsWith('/') && !ready.length && (await runSlash(t))) {
      setText('');
      return;
    }
    const ok = await sendMessage(t, ready);
    if (ok) {
      setText('');
      setChips([]);
    }
  }, [text, canSend, ready, runSlash]);

  // подсказки: «/команда» в начале и «@файл» у курсора
  const updatePopup = useCallback(
    (value: string, caret: number) => {
      const slash = /^\/(\S*)$/.exec(value);
      if (slash) {
        const q = (slash[1] ?? '').toLowerCase();
        const items = commands
          .filter((c: CommandInfo) => c.name.toLowerCase().startsWith(q))
          .slice(0, 8)
          .map((c) => ({
            label: `/${c.name}`,
            hint: c.description,
            run: () => {
              setText(`/${c.name} `);
              setPopup(null);
              area.current?.focus();
            },
          }));
        setPopup(items.length ? { kind: 'slash', items, index: 0 } : null);
        return;
      }
      const at = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
      if (at) {
        const q = at[2] ?? '';
        if (!q) return setPopup({ kind: 'mention', items: [{ label: 'Начните вводить имя файла…' , run: () => undefined }], index: 0 });
        void bridge.call('fs.search', { query: q, mode: 'name' }).then(
          (hits) => {
            const items = hits.slice(0, 8).map((h) => ({
              label: h.path,
              run: () => {
                const before = value.slice(0, caret).replace(/(^|\s)@[^\s@]*$/, '$1');
                setText(before + value.slice(caret));
                setPopup(null);
                void addProjectFile(h.path);
                area.current?.focus();
              },
            }));
            setPopup(items.length ? { kind: 'mention', items, index: 0 } : null);
          },
          () => setPopup(null),
        );
        return;
      }
      setPopup(null);
    },
    [commands, addProjectFile],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setPopup({ ...popup, index: (popup.index + d + popup.items.length) % popup.items.length });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && popup.kind === 'mention')) {
        e.preventDefault();
        popup.items[popup.index]?.run();
        return;
      }
      if (e.key === 'Enter' && popup.kind === 'slash') {
        // для /команды Enter выполняет введённое, а выбор из списка — Tab
        const exact = commands.some((c) => `/${c.name}` === text.trim());
        if (!exact) {
          e.preventDefault();
          popup.items[popup.index]?.run();
          return;
        }
      }
      if (e.key === 'Escape') {
        setPopup(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && running) {
      void abort();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const project = e.dataTransfer.getData('application/x-gemmacode-path');
    if (project) return void addProjectFile(project);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const mode = session?.mode ?? 'ask';
  const ctx = session?.context;
  const pct = ctx ? Math.min(100, Math.round((ctx.used / ctx.limit) * 100)) : 0;
  const modelName = backend.model ?? (info?.configured ? '' : 'модель не выбрана');
  const dot = backend.status === 'ready' ? 'ok' : backend.status === 'starting' ? 'warn' : backend.status === 'error' ? 'err' : 'off';
  const modeInfo = useMemo(() => MODES.find((m) => m.id === mode), [mode]);

  return (
    <div
      className={`composer${drag ? ' drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={onDrop}
    >
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((c) => (
            <span key={c.key} className={`att-chip ${c.status}`} title={c.error ?? c.ref?.note ?? c.name}>
              {c.status === 'processing' ? <Spinner size={12} /> : c.preview ? <img src={c.preview} alt="" /> : c.kind === 'image' ? <IconImage /> : c.kind === 'audio' ? <IconAudio /> : <IconFile />}
              <span className="att-name">{c.name}</span>
              {c.ref?.note && <span className="att-note">{c.ref.note}</span>}
              <button className="chip-x" onClick={() => setChips((x) => x.filter((y) => y.key !== c.key))} aria-label={`Убрать ${c.name}`}>
                <IconClose size={11} />
              </button>
            </span>
          ))}
          {attachTokens > 0 && <span className="muted small-text">≈ {formatTokens(attachTokens)} токенов контекста</span>}
        </div>
      )}
      <div className="input-row">
        <button className="icon" onClick={() => fileInput.current?.click()} title="Прикрепить файл, фото или звук" aria-label="Прикрепить">
          <IconClip />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && (addFiles(e.target.files), (e.target.value = ''))} />
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={session ? 'Сообщение агенту. «/» — команды, «@» — файл проекта, можно перетащить фото' : 'Откройте проект'}
          disabled={!session}
          onChange={(e) => {
            setText(e.target.value);
            updatePopup(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {running ? (
          <button className="send stop" onClick={() => void abort()} title="Остановить (Esc)" aria-label="Остановить">
            <IconStop />
          </button>
        ) : (
          <button className="send" disabled={!canSend} onClick={() => void submit()} title="Отправить (Enter)" aria-label="Отправить">
            <IconSend />
          </button>
        )}
        {popup && (
          <ul className="popup" role="listbox">
            {popup.items.map((it, i) => (
              <li key={i} role="option" aria-selected={i === popup.index} className={i === popup.index ? 'sel' : ''} onMouseDown={(e) => (e.preventDefault(), it.run())}>
                <span>{it.label}</span>
                {it.hint && <span className="muted"> {it.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="statusbar">
        <select value={mode} onChange={(e) => void setMode(e.target.value as PermissionMode)} title={modeInfo?.hint} aria-label="Режим прав">
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {session?.verify && (
          <button className="chip-btn" onClick={() => void setVerify(null)} title="Выключить проверку">
            проверка: {session.verify} <IconClose size={10} />
          </button>
        )}
        <span className="spacer" />
        {ctx && (
          <span className="meter" title={`Контекст: ${ctx.used} из ${ctx.limit} токенов`}>
            <span className="meter-bar">
              <span style={{ width: `${pct}%` }} className={pct > 85 ? 'hot' : ''} />
            </span>
            {formatTokens(ctx.used)} / {formatTokens(ctx.limit)}
          </span>
        )}
        {speed > 0 && <span className="muted">{speed.toFixed(1)} ток/с</span>}
        <span className="model" title={backend.message ?? ''}>
          <span className={`dot ${dot}`} /> {modelName || (backend.status === 'ready' ? 'готова' : '')}
        </span>
      </div>
    </div>
  );
}
