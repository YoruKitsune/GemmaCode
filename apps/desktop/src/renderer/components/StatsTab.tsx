import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DayStat, ProjectStats, TurnStat } from '@gemmacode/protocol';
import { bridge } from '../bridge';
import { useStore } from '../store';

const TARGET_TPS = 60;

function fmt(n: number): string {
  return n.toLocaleString('ru-RU');
}

function days(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function DayChart({ data }: { data: DayStat[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const list = useMemo(() => {
    const by = new Map(data.map((d) => [d.day, d]));
    return days(30).map((day) => by.get(day) ?? { day, added: 0, removed: 0, turns: 0 });
  }, [data]);
  const max = Math.max(1, ...list.map((d) => Math.max(d.added, d.removed)));
  const W = 300;
  const H = 120;
  const mid = 60;
  const bw = W / list.length;
  const cur = hover === null ? null : list[hover];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Строки, изменённые агентом по дням за 30 дней" onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={mid} y2={mid} className="axis" />
        {list.map((d, i) => (
          <g key={d.day} onMouseEnter={() => setHover(i)}>
            <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
            {d.added > 0 && <rect x={i * bw + 1} y={mid - (d.added / max) * 54} width={bw - 2} height={(d.added / max) * 54} rx="1.5" className="bar-add" />}
            {d.removed > 0 && <rect x={i * bw + 1} y={mid} width={bw - 2} height={(d.removed / max) * 54} rx="1.5" className="bar-del" />}
          </g>
        ))}
      </svg>
      <div className="chart-foot muted">
        {cur ? `${cur.day}: +${fmt(cur.added)} / −${fmt(cur.removed)}, ходов ${cur.turns}` : 'Выше оси — добавлено, ниже — удалено'}
      </div>
    </div>
  );
}

function SpeedChart({ data }: { data: TurnStat[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = data.slice(-40);
  if (pts.length === 0) return <div className="muted">Пока нет ходов.</div>;
  const W = 300;
  const H = 90;
  const top = Math.max(TARGET_TPS, ...pts.map((p) => p.genTps)) * 1.1;
  const x = (i: number) => (pts.length === 1 ? W / 2 : 6 + (i / (pts.length - 1)) * (W - 12));
  const y = (v: number) => H - 8 - (v / top) * (H - 16);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.genTps).toFixed(1)}`).join(' ');
  const cur = hover === null ? null : pts[hover];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Скорость генерации по последним ходам" onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={y(TARGET_TPS)} y2={y(TARGET_TPS)} className="target" />
        <text x={W - 2} y={y(TARGET_TPS) - 3} textAnchor="end" className="chart-label">цель {TARGET_TPS}</text>
        <path d={path} className="line" />
        {pts.map((p, i) => (
          <g key={p.ts} onMouseEnter={() => setHover(i)}>
            <circle cx={x(i)} cy={y(p.genTps)} r="9" fill="transparent" />
            <circle cx={x(i)} cy={y(p.genTps)} r={hover === i ? 3.5 : 2.5} className="dot" />
          </g>
        ))}
      </svg>
      <div className="chart-foot muted">
        {cur ? `${new Date(cur.ts).toLocaleString('ru-RU')}: ${cur.genTps.toFixed(1)} ток/с, первый токен ${(cur.ttftMs / 1000).toFixed(1)} с` : `Последние ${pts.length} ходов, ток/с`}
      </div>
    </div>
  );
}

export function StatsTab({ visible }: { visible: boolean }) {
  const project = useStore((s) => s.project);
  const turnStats = useStore((s) => s.session?.stats);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  const load = useCallback(() => {
    bridge.call('stats.get', {}).then(
      (s) => (setStats(s), setError(null)),
      (e) => setError(String(e?.message ?? e)),
    );
  }, []);

  // перечитываем при показе вкладки, при смене проекта и когда закончился ход (меняется счётчик в сессии)
  const turnMark = turnStats ? `${turnStats.steps ?? ''}:${turnStats.generatedTokens ?? ''}` : '';
  useEffect(() => {
    if (visible && project) load();
  }, [visible, project?.path, turnMark, load]);

  const exportAs = async (format: 'csv' | 'json') => {
    const r = await bridge.call('stats.export', { format });
    const url = URL.createObjectURL(new Blob([r.text], { type: r.mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!project) return <div className="pad muted">Откройте проект, чтобы увидеть статистику.</div>;
  if (error) return <div className="pad"><span className="err-text">Не удалось получить статистику: {error}</span></div>;
  if (!stats) return <div className="pad muted">Считаем…</div>;

  const a = stats.agent;
  const maxLines = Math.max(1, ...stats.code.languages.map((l) => l.lines));
  return (
    <div className="stats" data-testid="stats">
      <div className="stats-bar">
        <button onClick={load}>Обновить</button>
        <button onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? 'Графики' : 'Таблицей'}</button>
        <span className="spacer" />
        <button onClick={() => exportAs('csv')}>CSV</button>
        <button onClick={() => exportAs('json')}>JSON</button>
      </div>
      {stats.dbError && <div className="stats-note">История ходов недоступна: {stats.dbError}. Показан только код и git.</div>}

      <h4>Код</h4>
      <div className="stat-grid">
        <Card label="Файлов" value={fmt(stats.code.files)} hint={stats.code.truncated ? 'подсчёт усечён' : undefined} />
        <Card label="Строк" value={fmt(stats.code.lines)} />
        <Card label="Коммитов за 30 дней" value={stats.git.isRepo ? fmt(stats.git.commits30) : '—'} hint={stats.git.isRepo ? `+${fmt(stats.git.added30)} / −${fmt(stats.git.removed30)}` : 'не git-репозиторий'} />
        <Card label="Не закоммичено" value={stats.git.isRepo ? `+${fmt(stats.git.uncommittedAdded)} / −${fmt(stats.git.uncommittedRemoved)}` : '—'} />
      </div>

      {table ? (
        <table className="stats-table">
          <thead><tr><th>Язык</th><th>Файлов</th><th>Строк</th></tr></thead>
          <tbody>{stats.code.languages.map((l) => <tr key={l.name}><td>{l.name}</td><td>{fmt(l.files)}</td><td>{fmt(l.lines)}</td></tr>)}</tbody>
        </table>
      ) : (
        <ul className="lang-list">
          {stats.code.languages.slice(0, 8).map((l) => (
            <li key={l.name}>
              <span className="lang-name">{l.name}</span>
              <span className="lang-bar"><span style={{ width: `${Math.max(2, (l.lines / maxLines) * 100)}%` }} /></span>
              <span className="lang-val">{fmt(l.lines)}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>Агент</h4>
      <div className="stat-grid">
        <Card label="Ходов" value={fmt(a.turns)} />
        <Card label="Токенов сгенерировано" value={fmt(a.generatedTokens)} hint={`на входе ${fmt(a.promptTokens)}`} />
        <Card label="Скорость, ток/с" value={a.turns ? a.avgGenTps.toFixed(1) : '—'} hint={`цель — ${TARGET_TPS}`} />
        <Card label="До первого токена" value={a.turns ? `${(a.avgTtftMs / 1000).toFixed(1)} с` : '—'} />
        <Card label="Кэш префикса" value={a.cachedTokens + a.promptTokens ? `${Math.round(a.cacheHitRate * 100)}%` : '—'} hint={`из кэша ${fmt(a.cachedTokens)}, пересчитано ${fmt(a.promptTokens)}`} />
        <Card label="Ускорение" value={a.speculative === 'none' ? 'выключено' : a.speculative === 'external' ? 'чужой сервер' : a.speculative} hint={a.draftTokens ? `принято ${Math.round(a.acceptRate * 100)}% из ${fmt(a.draftTokens)} токенов черновика` : 'черновиков пока не было'} />
        <Card label="Инструменты без ошибок" value={a.toolCalls ? `${Math.round(a.toolSuccess * 100)}%` : '—'} hint={`${fmt(a.toolCalls)} вызовов, ${fmt(a.toolErrors)} с ошибкой`} />
        <Card label="Память модели" value={a.modelRssMB ? `${(a.modelRssMB / 1024).toFixed(1)} ГБ` : '—'} hint={a.modelName ?? undefined} />
      </div>

      {table ? (
        <table className="stats-table">
          <thead><tr><th>День</th><th>Ходов</th><th>+</th><th>−</th></tr></thead>
          <tbody>{a.byDay.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.turns}</td><td>{fmt(d.added)}</td><td>{fmt(d.removed)}</td></tr>)}</tbody>
        </table>
      ) : (
        <>
          <h5>Правки агента за 30 дней: +{fmt(a.added)} / −{fmt(a.removed)}</h5>
          <DayChart data={a.byDay} />
          <h5>Скорость генерации</h5>
          <SpeedChart data={a.recent} />
        </>
      )}

      {a.tools.length > 0 && (
        <>
          <h5>Инструменты</h5>
          <table className="stats-table">
            <thead><tr><th>Имя</th><th>Вызовов</th><th>Ошибок</th></tr></thead>
            <tbody>{a.tools.map((t) => <tr key={t.name}><td>{t.name}</td><td>{fmt(t.calls)}</td><td>{fmt(t.errors)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
