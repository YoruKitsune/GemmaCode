import { useEffect } from 'react';
import { boot, newSession, pickAndOpenProject, showTab } from './actions';
import { Approvals } from './components/Approval';
import { ConfirmDialog, PromptDialog, QuickOpen } from './components/Dialogs';
import { Composer } from './components/Composer';
import { Feed } from './components/Feed';
import { IconDiff, IconPanel } from './components/icons';
import { RightPanel } from './components/RightPanel';
import { ModelSetup } from './components/ModelSetup';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { Welcome } from './components/Welcome';
import { startEvents } from './events';
import { setState, useStore } from './store';

export function App() {
  const booted = useStore((s) => s.booted);
  const project = useStore((s) => s.project);

  useEffect(() => {
    const stop = startEvents();
    void boot();
    return stop;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'o') (e.preventDefault(), void pickAndOpenProject());
      else if (k === 'n') (e.preventDefault(), void newSession());
      else if (k === 'b') (e.preventDefault(), setState((s) => ({ panelOpen: !s.panelOpen })));
      else if (k === 'p') (e.preventDefault(), setState({ quickOpen: true }));
      else if (e.key === '`') (e.preventDefault(), showTab('terminal'));
      else if (k === ',') (e.preventDefault(), setState({ settingsOpen: true }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!booted) return <div className="boot muted">Загрузка…</div>;

  return (
    <>
      {project ? <Workspace /> : <Welcome />}
      <SettingsDialog />
      <ConfirmDialog />
      <PromptDialog />
      <QuickOpen />
      <Toasts />
    </>
  );
}

function Workspace() {
  const panelOpen = useStore((s) => s.panelOpen);
  const title = useStore((s) => s.session?.title);
  const changes = useStore((s) => s.session?.touched.length ?? 0);
  const info = useStore((s) => s.info);
  const backend = useStore((s) => s.backend);
  const project = useStore((s) => s.project);
  return (
    <div className="shell">
      <Sidebar />
      <main className="chat">
        <header className="chat-head">
          <div className="drag-region" />
          <h1 className="chat-title">{title || 'Новая сессия'}</h1>
          <span className="spacer" />
          {changes > 0 && (
            <button className="ghost small" onClick={() => showTab('changes')} title="Показать изменения сессии">
              <IconDiff size={14} /> {changes} файл.
            </button>
          )}
          <button className={`icon${panelOpen ? ' on' : ''}`} onClick={() => setState({ panelOpen: !panelOpen })} title="Рабочая область (⌘B)" aria-label="Рабочая область">
            <IconPanel />
          </button>
        </header>
        {project && project.warnings.length > 0 && <div className="banner warn">{project.warnings.join(' · ')}</div>}
        {info && !info.configured && backend.status !== 'ready' && (
          <div className="banner-block">
            <ModelSetup />
            <p className="muted small-text">
              Уже есть модель? <button className="link" onClick={() => setState({ settingsOpen: true })}>Открыть настройки</button> и укажите файл GGUF или адрес llama-server.
            </p>
          </div>
        )}
        {backend.status === 'error' && (
          <div className="banner warn">
            Не удалось запустить модель: {backend.message}
            <button className="link" onClick={() => setState({ settingsOpen: true })}>Настройки</button>
          </div>
        )}
        <Feed />
        <div className="dock">
          <Approvals />
          <Composer />
        </div>
      </main>
      {panelOpen && <RightPanel />}
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} role={t.level === 'error' ? 'alert' : 'status'}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

