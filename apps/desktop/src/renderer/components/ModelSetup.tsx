import { useState } from 'react';
import { cancelModelDownload, downloadModel, refreshModel } from '../actions';
import { formatBytes } from '../format';
import { useStore } from '../store';

function eta(p: { overallReceived: number; overallTotal: number; bytesPerSec: number }): string {
  if (p.bytesPerSec <= 0) return '';
  const s = Math.round((p.overallTotal - p.overallReceived) / p.bytesPerSec);
  if (s < 60) return `осталось ${s} с`;
  if (s < 3600) return `осталось ${Math.round(s / 60)} мин`;
  return `осталось ${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;
}

const FIT_TEXT = { ok: 'подходит', tight: 'впритык, будут тормоза', no: 'не хватит памяти' } as const;

/**
 * Скачивание модели (по умолчанию Gemma 4 E2B; E4B и 12B выбираются списком, у каждой видно, хватит ли памяти этой машины). Загрузка идёт в фоне в сервисе агента, её можно остановить и продолжить,
 * после обрыва связи она сама продолжается с места обрыва. Скачанное работает офлайн.
 */
export function ModelSetup({ compact = false }: { compact?: boolean }) {
  const model = useStore((s) => s.model);
  const [withMmproj, setWithMmproj] = useState(true);
  if (!model) return null;
  const main = model.files.find((f) => f.role === 'model');
  const proj = model.files.find((f) => f.role === 'mmproj');
  if (!main) return null;
  const allReady = main.state === 'ready' && (!withMmproj || !proj || proj.state === 'ready');
  const p = model.progress;
  const resumable = model.files.some((f) => f.state === 'partial');
  const total = main.size + (withMmproj && proj ? proj.size : 0);

  return (
    <div className={`model-setup${compact ? ' compact' : ''}`}>
      {!compact && <h3>Нужна модель</h3>}
      {!model.downloading && model.catalog.length > 1 && (
        <fieldset className="model-pick" aria-label="Модель">
          {model.catalog.map((o) => (
            <label key={o.id} className={`check small-text model-opt fit-${o.fit}`}>
              <input type="radio" name="model-pick" checked={model.modelId === o.id} onChange={() => void refreshModel(o.id)} />
              <span>
                <b>{o.label}</b> · {formatBytes(o.modelBytes)} · {FIT_TEXT[o.fit]}
                {o.recommended ? ' · рекомендуется для вашей памяти' : ''}
                {o.installed ? ' · скачана' : ''}
                <span className="muted model-note">{o.note}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {(() => {
        const cur = model.catalog.find((o) => o.id === model.modelId);
        if (!cur || cur.fit === 'ok') return null;
        return (
          <p className="small-text error-text" role="alert">
            {cur.fit === 'no' ? `Этой машине не хватит памяти для ${cur.label} (нужно от ${cur.minRamGB} ГБ). Модель может не запуститься или остановить систему.` : `Памяти впритык для ${cur.label} (комфортно от ${cur.minRamGB} ГБ): возможны тормоза.`}
          </p>
        );
      })()}
      <p className="muted small-text">
        {model.title}: {formatBytes(main.size)}
        {proj ? `, плюс ${formatBytes(proj.size)} для фото и звука` : ''}. Скачивается один раз с Hugging Face ({model.repo}), дальше работает без интернета. Лицензия модели: {model.license}.
      </p>
      {!model.downloading && !allReady && proj && (
        <label className="check small-text">
          <input type="checkbox" checked={withMmproj} onChange={(e) => setWithMmproj(e.target.checked)} /> Фото и звук (+{formatBytes(proj.size)}, больше памяти при работе)
        </label>
      )}
      {model.downloading && p && (
        <div className="progress-box" role="status" aria-live="polite">
          <div className="progress-bar" aria-label="Загрузка модели">
            <span style={{ width: `${Math.min(100, (p.overallReceived / Math.max(1, p.overallTotal)) * 100)}%` }} />
          </div>
          <div className="small-text muted">
            {p.phase === 'verifying' ? `Проверяю ${p.file} (SHA-256)…` : p.phase === 'done' ? 'Готово' : `${p.file}`} · {formatBytes(p.overallReceived)} из {formatBytes(p.overallTotal)}
            {p.phase === 'downloading' && p.bytesPerSec > 0 ? ` · ${formatBytes(p.bytesPerSec)}/с · ${eta(p)}` : ''}
            {p.attempt > 0 ? ` · связь прервалась, попытка ${p.attempt + 1}` : ''}
          </div>
        </div>
      )}
      {model.downloading && !p && <p className="small-text muted">Подключаюсь…</p>}
      {model.error && <p className="small-text error-text">{model.error}</p>}
      <div className="row">
        {model.downloading ? (
          <button onClick={() => void cancelModelDownload()}>Остановить</button>
        ) : allReady ? (
          <span className="small-text muted">Модель скачана.</span>
        ) : (
          <button className="primary" onClick={() => void downloadModel(withMmproj, model.modelId)}>
            {model.error ? 'Повторить' : resumable ? 'Продолжить загрузку' : `Скачать (${formatBytes(total)})`}
          </button>
        )}
      </div>
    </div>
  );
}
