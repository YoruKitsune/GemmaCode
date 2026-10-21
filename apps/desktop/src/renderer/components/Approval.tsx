import { useEffect } from 'react';
import { answerApproval } from '../actions';
import { useStore } from '../store';
import { DiffView } from './DiffView';
import { IconShield } from './icons';

export function Approvals() {
  const approvals = useStore((s) => s.approvals);
  const a = approvals[0];

  // Enter разрешает, Esc отклоняет, пока карточка на экране и фокус не в поле ввода текста
  useEffect(() => {
    if (!a) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
      if (e.key === 'Enter') void answerApproval(a.id, 'allow');
      else if (e.key === 'Escape') void answerApproval(a.id, 'deny');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a?.id]);

  if (!a) return null;
  return (
    <div className="approval" role="alertdialog" aria-label="Нужно подтверждение">
      <div className="approval-head">
        <IconShield /> <strong>Нужно подтверждение</strong>
        {approvals.length > 1 && <span className="tag">ещё {approvals.length - 1}</span>}
      </div>
      <div className="approval-summary">
        <span className="tool-name">{a.tool}</span> {a.summary}
      </div>
      <div className="muted small-text">{translateReason(a.reason)}</div>
      {a.detail && <pre className="cmd">{a.detail}</pre>}
      {a.diff && (
        <div className="approval-diff">
          <DiffView diff={a.diff} maxLines={120} />
        </div>
      )}
      <div className="approval-actions">
        <button className="primary" onClick={() => void answerApproval(a.id, 'allow')}>
          Разрешить
        </button>
        {a.grantLabel && (
          <button onClick={() => void answerApproval(a.id, 'allow-session')} title="Не спрашивать повторно до конца сессии">
            Разрешить для сессии: {translateGrant(a.grantLabel)}
          </button>
        )}
        <button className="ghost" onClick={() => void answerApproval(a.id, 'deny')}>
          Отклонить
        </button>
      </div>
    </div>
  );
}

function translateReason(r: string): string {
  const map: [RegExp, string][] = [
    [/^File change$/, 'Изменение файла'],
    [/^Command$/, 'Команда'],
    [/^Untrusted content was read in this session\.?$/, 'В этой сессии прочитаны недоверенные данные (веб, внешний файл или MCP), поэтому записи и команды требуют подтверждения.'],
    [/^No OS sandbox on this system: every command needs approval\.?$/, 'В системе нет песочницы ОС: каждая команда требует подтверждения.'],
    [/^The command asks for network access\.?$/, 'Команда просит доступ к сети.'],
    [/^Controls a program on this computer$/, 'Управляет программой на этом компьютере.'],
    [/^External tool \(MCP\)$/, 'Внешний инструмент (MCP).'],
    [/^Reads outside the project: (.*)$/, 'Чтение вне папки проекта: $1'],
    [/^Writes outside the project: (.*)$/, 'Запись вне папки проекта: $1'],
    [/^The command mentions a secrets or browser data location\.?$/, 'Команда обращается к секретам или данным браузера.'],
  ];
  for (const [re, ru] of map) if (re.test(r)) return r.replace(re, ru);
  return r;
}

function translateGrant(g: string): string {
  if (g === 'all file edits in this session') return 'все правки файлов';
  if (g === 'this exact command in this session') return 'эта команда';
  if (g === 'this path') return 'этот путь';
  return g;
}
