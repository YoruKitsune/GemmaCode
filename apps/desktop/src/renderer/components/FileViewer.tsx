import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileContent } from '@gemmacode/protocol';
import { bridge } from '../bridge';
import { composerBus } from '../events';
import { createEditor, type EditorHandle } from '../editor';
import { formatBytes } from '../format';
import { toast, useStore } from '../store';
import { IconFile } from './icons';
import { CsvPreview, HtmlPreview, JsonPreview, MarkdownPreview, PdfPreview, previewKindOf } from './Preview';

/** Просмотр и правка файла проекта: текст в CodeMirror, картинки и звук встроенными элементами. */
export function FileViewer({ path, onDirty }: { path: string; onDirty(dirty: boolean): void }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const dirtyRef = useRef(false);
  const fsVersion = useStore((s) => s.fsVersion);
  const fsPaths = useStore((s) => s.fsPaths);
  const mtime = useRef(0);
  const previewKind = previewKindOf(path);
  // PDF и таблицы открываются сразу в просмотре, остальное — в редакторе
  const [view, setView] = useState<'code' | 'preview'>(previewKind === 'pdf' || previewKind === 'csv' ? 'preview' : 'code');

  // onDirty приходит новой функцией на каждый рендер родителя; через ref колбэки остаются стабильными и редактор не пересоздаётся
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const markDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
    setDirty(d);
    onDirtyRef.current(d);
  }, []);

  const load = useCallback(async (onlyIfChanged = false) => {
    try {
      const f = await bridge.call('fs.read', { path });
      if (onlyIfChanged && f.mtime === mtime.current) return;
      mtime.current = f.mtime;
      setFile(f);
      setError('');
      setStale(false);
      markDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path, markDirty]);

  useEffect(() => void load(), [load]);

  // файл изменили агент, откат или внешний редактор
  useEffect(() => {
    if (!file || !fsPaths.includes(path)) return;
    if (dirtyRef.current) setStale(true);
    else void load(true);
  }, [fsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    const ed = editor.current;
    if (!ed) return;
    try {
      const r = await bridge.call('fs.write', { path, text: ed.getText() });
      mtime.current = r.mtime;
      markDirty(false);
      setStale(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }, [path, markDirty]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (file?.kind !== 'text' || !host.current || (previewKind && view === 'preview')) return;
    const ed = createEditor(host.current, { doc: file.text, path, readOnly: Boolean(file.truncated), onChange: () => markDirty(true), onSave: () => void saveRef.current() });
    editor.current = ed;
    return () => {
      ed.destroy();
      editor.current = null;
    };
  }, [file, path, markDirty, view, previewKind]);

  if (error) return <div className="viewer-msg">{error}</div>;
  if (!file) return <div className="viewer-msg muted">Загрузка…</div>;

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span className="viewer-path" title={path}>{path}</span>
        <span className="muted">{formatBytes(file.size)}</span>
        <span className="spacer" />
        {previewKind && previewKind !== 'pdf' && (
          <div className="seg" role="group" aria-label="Вид файла">
            <button className={`small${view === 'code' ? ' on' : ''}`} aria-pressed={view === 'code'} onClick={() => setView('code')}>Код</button>
            <button className={`small${view === 'preview' ? ' on' : ''}`} aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Просмотр</button>
          </div>
        )}
        <button className="ghost small" onClick={() => composerBus.dispatchEvent(new CustomEvent('attach', { detail: path }))} title="Прикрепить файл к сообщению">
          В чат
        </button>
        {file.kind === 'text' && !file.truncated && (
          <button className="small" disabled={!dirty} onClick={() => void save()} title="Сохранить (⌘S / Ctrl+S)">
            Сохранить
          </button>
        )}
      </div>
      {stale && (
        <div className="banner">
          Файл изменился на диске, а в редакторе есть несохранённые правки.
          <button className="small" onClick={() => void load()}>Загрузить с диска</button>
          <button className="ghost small" onClick={() => setStale(false)}>Оставить мои</button>
        </div>
      )}
      {file.kind === 'text' && view === 'preview' && previewKind === 'markdown' && <MarkdownPreview text={file.text} />}
      {file.kind === 'text' && view === 'preview' && previewKind === 'html' && <HtmlPreview path={path} />}
      {file.kind === 'text' && view === 'preview' && previewKind === 'csv' && <CsvPreview text={file.text} path={path} />}
      {file.kind === 'text' && view === 'preview' && previewKind === 'json' && <JsonPreview text={file.text} />}
      {file.kind === 'pdf' && <PdfPreview dataUrl={file.dataUrl} />}
      {file.kind === 'text' && (view === 'code' || !previewKind) && (
        <>
          {file.truncated && <div className="banner">Файл больше 1 МБ: показано начало, редактирование выключено.</div>}
          <div className="editor" ref={host} />
        </>
      )}
      {file.kind === 'image' && (
        <div className="media">
          <img src={file.dataUrl} alt={path} />
        </div>
      )}
      {file.kind === 'audio' && (
        <div className="media">
          <audio controls src={file.dataUrl} />
        </div>
      )}
      {file.kind === 'video' && (
        <div className="media">
          <video controls src={file.dataUrl} />
        </div>
      )}
      {file.kind === 'binary' && (
        <div className="media muted">
          <IconFile size={28} />
          <p>Бинарный файл, предпросмотр недоступен.</p>
        </div>
      )}
    </div>
  );
}
