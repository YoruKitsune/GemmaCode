import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { closeFile, showTab } from '../actions';
import { baseName } from '../format';
import { setState, useStore, type RightTab } from '../store';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { IconClose, IconDiff, IconFolder, IconChart, IconGlobe, IconTerminal } from './icons';

// редактор и терминал тяжёлые (CodeMirror, xterm): грузим при первом открытии, а не при старте окна
const FileViewer = lazy(() => import('./FileViewer').then((m) => ({ default: m.FileViewer })));
const TerminalTab = lazy(() => import('./TerminalTab').then((m) => ({ default: m.TerminalTab })));
const StatsTab = lazy(() => import('./StatsTab').then((m) => ({ default: m.StatsTab })));
const BrowserTab = lazy(() => import('./BrowserTab').then((m) => ({ default: m.BrowserTab })));

export function RightPanel() {
  const tab = useStore((s) => s.tab);
  const openFiles = useStore((s) => s.openFiles);
  const changeCount = useStore((s) => s.session?.touched.length ?? 0);
  const width = useStore((s) => s.panelWidth);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const dragging = useRef(false);
  const termSeen = useRef(false);
  if (tab === 'terminal') termSeen.current = true;
  const browserSeen = useRef(false);
  if (tab === 'browser') browserSeen.current = true;
  const statsSeen = useRef(false);
  if (tab === 'stats') statsSeen.current = true;

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onResize = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    setState({ panelWidth: Math.round(Math.min(Math.max(window.innerWidth - e.clientX, 320), window.innerWidth - 420)) });
  }, []);

  const tabBtn = (id: RightTab, label: string, icon?: React.ReactNode, badge?: number) => (
    <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => showTab(id)} role="tab" aria-selected={tab === id}>
      {icon}
      {label}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );

  return (
    <section className="panel" style={{ width }} aria-label="Рабочая область">
      <div className="resizer" onPointerDown={onResizeStart} onPointerMove={onResize} onPointerUp={() => (dragging.current = false)} />
      <div className="tabs" role="tablist">
        {tabBtn('files', 'Файлы', <IconFolder size={14} />)}
        {tabBtn('changes', 'Изменения', <IconDiff size={14} />, changeCount)}
        {tabBtn('terminal', 'Терминал', <IconTerminal size={14} />)}
        {tabBtn('browser', 'Браузер', <IconGlobe size={14} />)}
        {tabBtn('stats', 'Статистика', <IconChart size={14} />)}
        {openFiles.map((p) => (
          <span key={p} className={`tab file-tab${tab === `file:${p}` ? ' active' : ''}`} onClick={() => showTab(`file:${p}`)} title={p} role="tab">
            {baseName(p)}
            {dirty.has(p) && <span className="dirty" title="Есть несохранённые правки">●</span>}
            <button className="icon tiny" aria-label={`Закрыть ${baseName(p)}`} onClick={(e) => (e.stopPropagation(), closeFile(p))}>
              <IconClose size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="tab-body">
        <div className="pane" hidden={tab !== 'files'}>
          <FilesTab />
        </div>
        <div className="pane" hidden={tab !== 'changes'}>
          {tab === 'changes' && <ChangesTab />}
        </div>
        {(tab === 'terminal' || termSeen.current) && (
          <div className="pane" hidden={tab !== 'terminal'}>
            <Suspense fallback={<div className="pad muted">Загрузка…</div>}>
              <TerminalTab visible={tab === 'terminal'} />
            </Suspense>
          </div>
        )}
        {(tab === 'browser' || browserSeen.current) && (
          <div className="pane" hidden={tab !== 'browser'}>
            <Suspense fallback={<div className="pad muted">Загрузка…</div>}>
              <BrowserTab visible={tab === 'browser'} />
            </Suspense>
          </div>
        )}
        {(tab === 'stats' || statsSeen.current) && (
          <div className="pane" hidden={tab !== 'stats'}>
            <Suspense fallback={<div className="pad muted">Загрузка…</div>}>
              <StatsTab visible={tab === 'stats'} />
            </Suspense>
          </div>
        )}
        {openFiles.map((p) => (
          <div className="pane" key={p} hidden={tab !== `file:${p}`}>
            <Suspense fallback={<div className="pad muted">Загрузка…</div>}>
            <FileViewer
              path={p}
              onDirty={(d) =>
                setDirty((s) => {
                  const n = new Set(s);
                  if (d) n.add(p);
                  else n.delete(p);
                  return n;
                })
              }
            />
            </Suspense>
          </div>
        ))}
      </div>
    </section>
  );
}
