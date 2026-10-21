import { useEffect, useMemo, useState } from 'react';
import { diffStats } from '@gemmacode/protocol';
import { confirmRollback, openFile, refreshChanges } from '../actions';
import { useStore } from '../store';
import { DiffView } from './DiffView';
import { IconUndo } from './icons';

export function ChangesTab() {
  const changes = useStore((s) => s.changes);
  const scope = useStore((s) => s.changesScope);
  const checkpoints = useStore((s) => s.session?.checkpoints ?? []);
  const running = useStore((s) => s.session?.running ?? false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => void refreshChanges(), []);

  const total = useMemo(() => changes.reduce((a, c) => {
    const st = diffStats(c.diff);
    return { added: a.added + st.added, removed: a.removed + st.removed };
  }, { added: 0, removed: 0 }), [changes]);

  const withChanges = checkpoints.filter((c) => c.files > 0);
  const cp = typeof scope === 'number' ? checkpoints.find((c) => c.id === scope) : undefined;

  return (
    <div className="changes">
      <div className="changes-bar">
        <select value={String(scope)} onChange={(e) => void refreshChanges(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="Область изменений">
          <option value="all">Вся сессия</option>
          {withChanges.map((c) => (
            <option key={c.id} value={c.id}>
              Ход {c.id}: {c.label.slice(0, 40)} ({c.files})
            </option>
          ))}
        </select>
        <span className="muted">
          {changes.length} файл. <span className="add">+{total.added}</span> <span className="del">−{total.removed}</span>
        </span>
        <span className="spacer" />
        {cp && (
          <button className="small" disabled={running} onClick={() => confirmRollback(cp.id, cp.label)}>
            <IconUndo size={13} /> Откатить с этого хода
          </button>
        )}
      </div>
      {changes.length === 0 && <div className="muted pad">В этой области файлы не менялись.</div>}
      <ul className="change-list">
        {changes.map((c) => {
          const st = diffStats(c.diff);
          const isOpen = open.has(c.path);
          return (
            <li key={c.path}>
              <button
                className="change-head"
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(c.path)) n.delete(c.path);
                    else n.add(c.path);
                    return n;
                  })
                }
                aria-expanded={isOpen}
              >
                <span className="change-path">{c.path}</span>
                {c.created && <span className="tag">новый</span>}
                {c.deleted && <span className="tag">удалён</span>}
                <span className="add">+{st.added}</span>
                <span className="del">−{st.removed}</span>
              </button>
              {isOpen && (
                <>
                  <DiffView diff={c.diff} />
                  {!c.deleted && (
                    <button className="ghost small" onClick={() => openFile(c.path)}>
                      Открыть файл
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

