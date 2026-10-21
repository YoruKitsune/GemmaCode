import { useMemo } from 'react';
import { parseUnifiedDiff } from '@gemmacode/protocol';

export function DiffView({ diff, maxLines = 400 }: { diff: string; maxLines?: number }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  let shown = 0;
  return (
    <div className="diff" role="group" aria-label="Изменения">
      {files.map((f, fi) => (
        <div key={fi} className="diff-file">
          {files.length > 1 && <div className="diff-title">{f.newPath === '/dev/null' ? f.oldPath : f.newPath}</div>}
          {f.hunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">{h.header}</div>
              {h.lines.map((l, li) => {
                if (shown++ > maxLines) return li === 0 || shown === maxLines + 2 ? <div key={li} className="diff-more">… остальное скрыто</div> : null;
                return (
                  <div key={li} className={`diff-line diff-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>
                    <span className="ln">{l.oldNo ?? ''}</span>
                    <span className="ln">{l.newNo ?? ''}</span>
                    <span className="sign">{l.t === ' ' ? '' : l.t}</span>
                    <span className="code-text">{l.text || ' '}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
