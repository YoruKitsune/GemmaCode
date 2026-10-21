import { openProject, pickAndOpenProject } from '../actions';
import { dirName } from '../format';
import { setState, useStore } from '../store';

export function Welcome() {
  const info = useStore((s) => s.info);
  return (
    <div className="welcome">
      <div className="drag-region" />
      <div className="welcome-card">
        <h1>GemmaCode</h1>
        <p className="muted">Локальный агент для работы с кодом и файлами на Gemma 4. Всё остаётся на этом компьютере.</p>
        <button className="primary big" onClick={() => void pickAndOpenProject()}>
          Открыть папку проекта
        </button>
        {info && !info.configured && (
          <p className="callout">
            Модель ещё не выбрана. <button className="link" onClick={() => setState({ settingsOpen: true })}>Выбрать модель</button>
          </p>
        )}
        {info && info.recentProjects.length > 0 && (
          <>
            <h2 className="side-title">Недавние</h2>
            <ul className="recent">
              {info.recentProjects.map((p) => (
                <li key={p}>
                  <button className="recent-btn" onClick={() => void openProject(p)}>
                    <strong>{p.split('/').pop()}</strong>
                    <span className="muted"> {dirName(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
