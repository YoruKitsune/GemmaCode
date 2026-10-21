import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge';
import { renderMarkdown } from '../markdown';
import { dataUrlToBlob } from '../media';
import { toast, useStore } from '../store';
import { showTab } from '../actions';

/** Что можно показать «как есть» вместо исходника. */
export type PreviewKind = 'markdown' | 'html' | 'csv' | 'json' | 'pdf';

export function previewKindOf(path: string): PreviewKind | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'json') return 'json';
  if (ext === 'pdf') return 'pdf';
  return null;
}

// ---------- Markdown ----------

export function MarkdownPreview({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="preview-scroll markdown preview-md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.dataset.copy !== undefined) {
          void navigator.clipboard?.writeText(t.closest('.code')?.querySelector('code')?.textContent ?? '');
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

// ---------- HTML ----------

/** HTML в изолированном iframe: без доступа к окну и без общего origin. Локальные стили, скрипты и картинки подставляет сервис. */
export function HtmlPreview({ path }: { path: string }) {
  const fsVersion = useStore((s) => s.fsVersion);
  const [doc, setDoc] = useState<{ html: string; missing: string[] } | null>(null);
  const [error, setError] = useState('');

  // перерисовка при любом изменении файлов проекта (подставленные стили и скрипты тоже могли измениться), не чаще раза в 300 мс
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      bridge.call('fs.previewHtml', { path }).then(
        (r) => {
          if (cancelled) return;
          setDoc({ html: r.html, missing: r.missing });
          setError('');
        },
        (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [path, fsVersion]);

  const openInBrowser = () => {
    showTab('browser');
    void bridge.call('browser.open', { url: path }).catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'));
  };

  if (error) return <div className="viewer-msg">{error}</div>;
  return (
    <div className="preview-html">
      <div className="banner">
        Статичный просмотр: стили и картинки подтянуты, скрипты не выполняются. Чтобы увидеть страницу как есть, откройте её во встроенном браузере.
        <button className="small" onClick={openInBrowser}>Открыть в браузере</button>
        {doc && doc.missing.length > 0 && <span className="muted small-text">Не найдено: {doc.missing.slice(0, 3).join(', ')}</span>}
      </div>
      {doc && <iframe title={`Предпросмотр ${path}`} className="preview-frame" sandbox="" srcDoc={doc.html} />}
    </div>
  );
}

// ---------- CSV ----------

export function parseCsv(text: string, delimiter: string, maxRows: number): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let total = 0;
  const endRow = () => {
    row.push(cell);
    cell = '';
    total++;
    if (rows.length < maxRows) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') endRow();
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) endRow();
  return { rows, total };
}

export function CsvPreview({ text, path }: { text: string; path: string }) {
  const delimiter = path.toLowerCase().endsWith('.tsv') ? '\t' : text.split('\n', 1)[0]!.split(';').length > text.split('\n', 1)[0]!.split(',').length ? ';' : ',';
  const { rows, total } = useMemo(() => parseCsv(text, delimiter, 500), [text, delimiter]);
  if (!rows.length) return <div className="viewer-msg muted">Файл пуст.</div>;
  const [head, ...body] = rows;
  return (
    <div className="preview-scroll">
      <table className="csv">
        <thead>
          <tr>{head!.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{head!.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <p className="muted small-text pad">{total > rows.length ? `Показано ${rows.length} из ${total} строк.` : `Строк: ${total - 1}, столбцов: ${head!.length}.`}</p>
    </div>
  );
}

// ---------- JSON ----------

const MAX_CHILDREN = 200;

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const label = name !== undefined ? <span className="j-key">{name}: </span> : null;
  if (value === null || typeof value !== 'object') {
    const cls = typeof value === 'string' ? 'j-str' : typeof value === 'number' ? 'j-num' : 'j-lit';
    return (
      <div className="j-row">
        {label}
        <span className={cls}>{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
      </div>
    );
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <details open={depth < 2} className="j-node">
      <summary>
        {label}
        <span className="j-meta">{isArr ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </summary>
      <div className="j-children">
        {entries.slice(0, MAX_CHILDREN).map(([k, v]) => (
          <JsonNode key={k} name={isArr ? `[${k}]` : k} value={v} depth={depth + 1} />
        ))}
        {entries.length > MAX_CHILDREN && <div className="muted small-text">…ещё {entries.length - MAX_CHILDREN}</div>}
      </div>
    </details>
  );
}

export function JsonPreview({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);
  if (!parsed.ok) return <div className="viewer-msg">Некорректный JSON: {parsed.error}</div>;
  return (
    <div className="preview-scroll json-tree">
      <JsonNode value={parsed.value} depth={0} />
    </div>
  );
}

// ---------- PDF ----------

const PDF_MAX_PAGES = 40;

export function PdfPreview({ dataUrl }: { dataUrl: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ pages: number; shown: number } | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    (async () => {
      // pdf.js тяжёлый: грузим при первом открытии PDF, а не при старте окна
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      const data = new Uint8Array(await dataUrlToBlob(dataUrl).arrayBuffer());
      const doc = await pdfjs.getDocument({ data }).promise;
      const shown = Math.min(doc.numPages, PDF_MAX_PAGES);
      const width = Math.max(300, el.clientWidth - 24);
      for (let n = 1; n <= shown && !cancelled; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, width / base.width);
        const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page';
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / (window.devicePixelRatio || 1))}px`;
        el.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      }
      if (!cancelled) setState({ pages: doc.numPages, shown });
      void doc.destroy();
    })().catch((e) => !cancelled && setState({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [dataUrl]);

  return (
    <div className="preview-scroll pdf">
      {state && 'error' in state && <div className="viewer-msg">Не удалось показать PDF: {state.error}</div>}
      <div ref={host} className="pdf-pages" />
      {state && 'pages' in state && state.pages > state.shown && <p className="muted small-text pad">Показаны первые {state.shown} из {state.pages} страниц.</p>}
    </div>
  );
}
