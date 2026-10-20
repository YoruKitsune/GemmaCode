import { useEffect, useState } from 'react';
import type { AppInfo, GemmaCodeApi } from '../shared/ipc';

declare global {
  interface Window {
    gemmacode?: GemmaCodeApi;
  }
}

const PANELS = ['Браузер', 'Предпросмотр', 'Файлы', 'Статистика'] as const;

/** Каркас компоновки по плану: сессии слева, чат в центре, вкладки справа. */
export function App() {
  const [panel, setPanel] = useState<(typeof PANELS)[number]>('Файлы');
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.gemmacode?.getAppInfo().then(setInfo);
  }, []);

  return (
    <div className="shell">
      <aside className="sessions">
        <h2>Сессии</h2>
        <p className="muted">Пока пусто</p>
      </aside>
      <main className="chat">
        <div className="feed muted">Здесь будет лента действий агента.</div>
        <div className="composer">
          <input placeholder="Сообщение агенту…" disabled />
          <span className="muted">
            {info ? `${info.platform}, ${info.totalMemGB} ГБ ОЗУ` : 'модель не запущена'}
          </span>
        </div>
      </main>
      <section className="panel">
        <nav>
          {PANELS.map((p) => (
            <button key={p} className={p === panel ? 'active' : ''} onClick={() => setPanel(p)}>
              {p}
            </button>
          ))}
        </nav>
        <div className="panel-body muted">{panel}: заглушка</div>
      </section>
    </div>
  );
}
