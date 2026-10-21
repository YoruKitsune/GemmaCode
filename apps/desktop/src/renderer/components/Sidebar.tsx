import { deleteSession, newSession, pickAndOpenProject, selectSession } from '../actions';
import { relativeTime } from '../format';
import { setState, useStore } from '../store';
import { IconClose, IconFolder, IconPlus, IconSettings } from './icons';

export function Sidebar() {
  const project = useStore((s) => s.project);
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.session);
  const backend = useStore((s) => s.backend);
  const running = current?.running ?? false;

  // у текущей, ещё не сохранённой сессии заголовка нет: показываем её первой
  const list = current && !sessions.some((s) => s.id === current.id) ? [{ id: current.id, title: current.title || 'Новая сессия', updatedAt: Date.now() }, ...sessions] : sessions;

  return (
    <aside className="sidebar">
      <div className="drag-region" />
      <button className="project-btn" onClick={() => void pickAndOpenProject()} title={project?.path}>
        <IconFolder />
        <span className="project-name">{project?.name ?? 'Открыть проект'}</span>
      </button>
      <button className="new-session" onClick={() => void newSession()} disabled={!project}>
        <IconPlus /> Новая сессия
      </button>
      <h2 className="side-title">Сессии</h2>
      <ul className="sessions" role="list">
        {list.map((s) => (
          <li key={s.id} className={s.id === current?.id ? 'active' : ''}>
            <button className="session-btn" onClick={() => void selectSession(s.id)} title={s.title}>
              <span className="session-title">{s.title || 'Новая сессия'}</span>
              <span className="session-time">{s.id === current?.id && running ? '●' : relativeTime(s.updatedAt)}</span>
            </button>
            {sessions.some((x) => x.id === s.id) && (
              <button
                className="icon tiny session-x"
                aria-label="Удалить сессию"
                disabled={s.id === current?.id && running}
                onClick={() =>
                  setState({
                    confirm: { title: 'Удалить сессию?', text: `«${s.title}» и её история будут удалены. Файлы проекта не изменятся.`, ok: 'Удалить', danger: true, run: () => void deleteSession(s.id) },
                  })
                }
              >
                <IconClose size={12} />
              </button>
            )}
          </li>
        ))}
        {list.length === 0 && <li className="muted pad">Пока пусто</li>}
      </ul>
      <div className="side-foot">
        <span className={`dot ${backend.status === 'ready' ? 'ok' : backend.status === 'starting' ? 'warn' : backend.status === 'error' ? 'err' : 'off'}`} />
        <span className="model-name" title={backend.message}>
          {backend.status === 'ready' ? 'Модель готова' : backend.status === 'starting' ? 'Модель запускается…' : backend.status === 'error' ? 'Ошибка модели' : 'Модель не запущена'}
        </span>
        <button className="icon" onClick={() => setState({ settingsOpen: true })} title="Настройки" aria-label="Настройки">
          <IconSettings />
        </button>
      </div>
    </aside>
  );
}
