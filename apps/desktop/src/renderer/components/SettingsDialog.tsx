import { useEffect, useState } from 'react';
import type { FoundModel, PermissionMode, Settings } from '@gemmacode/protocol';
import { saveSettings } from '../actions';
import { bridge } from '../bridge';
import { setState, useStore } from '../store';
import { Modal } from './Dialogs';

const CONTEXTS = [8192, 16384, 32768];

/** Настройки модели и прав. Подключение: свой файл GGUF (запускаем llama-server сами) либо адрес уже запущенного сервера. */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const info = useStore((s) => s.info);
  const backend = useStore((s) => s.backend);
  const [found, setFound] = useState<FoundModel[] | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !info) return;
    setDraft(structuredClone(info.settings));
    setFound(null);
    void bridge.call('models.scan', {}).then(setFound, () => setFound([]));
  }, [open, info?.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !draft || !info) return null;
  const close = () => setState({ settingsOpen: false });
  const set = (patch: Partial<Settings['server']>) => setDraft({ ...draft, server: { ...draft.server, ...patch } });

  const pick = async (field: 'modelFile' | 'mmproj' | 'binary') => {
    const path = await bridge.pickPath({ kind: 'file', title: field === 'binary' ? 'llama-server' : 'Файл GGUF', ...(field !== 'binary' ? { filters: [{ name: 'GGUF', extensions: ['gguf'] }] } : {}) });
    if (path) set({ [field]: path });
  };

  const save = async () => {
    setSaving(true);
    const ok = await saveSettings({ mode: draft.mode, contextSize: draft.contextSize, server: draft.server });
    setSaving(false);
    if (ok) close();
  };

  const s = draft.server;
  const usingUrl = Boolean(s.url);

  return (
    <Modal title="Настройки" onClose={close} wide>
      <div className="settings">
        <h3>Модель</h3>
        <p className="muted small-text">Статус: {backend.status === 'ready' ? 'готова' : backend.status === 'starting' ? 'запускается' : backend.status === 'error' ? `ошибка: ${backend.message ?? ''}` : 'не запущена'}</p>
        {found && found.length > 0 && (
          <div className="found">
            <div className="small-text muted">Найдено на этом компьютере:</div>
            {found.map((m) => (
              <label key={m.file} className="radio">
                <input type="radio" name="model" checked={s.modelFile === m.file} onChange={() => setDraft({ ...draft, server: { ...s, url: undefined, modelFile: m.file, ...(m.mmproj ? { mmproj: m.mmproj } : {}) } })} />
                <span>
                  {m.file.split('/').pop()} <span className="muted">{(m.sizeMB / 1000).toFixed(1)} ГБ{m.mmproj ? ' · с поддержкой фото и звука' : ''}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="field">
          <span>Файл модели (GGUF)</span>
          <div className="field-row">
            <input value={s.modelFile ?? ''} onChange={(e) => set({ modelFile: e.target.value || undefined })} placeholder="/путь/к/gemma-4-E2B-it-Q4_K_M.gguf" disabled={usingUrl} />
            <button onClick={() => void pick('modelFile')} disabled={usingUrl}>Выбрать…</button>
          </div>
        </label>
        <label className="field">
          <span>Проектор для фото и звука (mmproj)</span>
          <div className="field-row">
            <input value={s.mmproj ?? ''} onChange={(e) => set({ mmproj: e.target.value || undefined })} placeholder="/путь/к/mmproj-F16.gguf" disabled={usingUrl} />
            <button onClick={() => void pick('mmproj')} disabled={usingUrl}>Выбрать…</button>
          </div>
          <span className="muted small-text">Без этого файла фото и звук недоступны. Модель можно запускать и без него: так она занимает меньше памяти.</span>
        </label>
        <label className="field">
          <span>Или адрес уже запущенного llama-server</span>
          <input value={s.url ?? ''} onChange={(e) => set({ url: e.target.value || undefined })} placeholder="http://127.0.0.1:8080" />
        </label>
        <details>
          <summary>Дополнительно</summary>
          <label className="field">
            <span>Программа llama-server</span>
            <div className="field-row">
              <input value={s.binary ?? ''} onChange={(e) => set({ binary: e.target.value || undefined })} placeholder="llama-server (из PATH)" />
              <button onClick={() => void pick('binary')}>Выбрать…</button>
            </div>
          </label>
          <label className="field">
            <span>Ускорение генерации (спекулятивный декодинг)</span>
            <select value={s.speculative ?? ''} onChange={(e) => set({ speculative: (e.target.value || undefined) as Settings['server']['speculative'] })} disabled={usingUrl}>
              <option value="">По умолчанию (ngram-simple)</option>
              <option value="none">Выключено</option>
              <option value="ngram-simple">ngram-simple</option>
              <option value="ngram-map-k">ngram-map-k</option>
            </select>
            <span className="muted small-text">Черновик берётся из уже встреченного текста, без второй модели и без лишней памяти. Сильно ускоряет правку файлов и повторы, на свободном тексте скорость прежняя.</span>
          </label>
        </details>

        <h3>Работа</h3>
        <div className="field-pair">
          <label className="field">
            <span>Контекст</span>
            <select value={draft.contextSize} onChange={(e) => setDraft({ ...draft, contextSize: Number(e.target.value) })}>
              {[...new Set([...CONTEXTS, draft.contextSize])].sort((a, b) => a - b).map((c) => (
                <option key={c} value={c}>
                  {c / 1024}K токенов{c === 16384 ? ' (рекомендуется для 8 ГБ)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Права по умолчанию</span>
            <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as PermissionMode })}>
              <option value="read-only">Только чтение</option>
              <option value="ask">Спрашивать</option>
              <option value="auto-edit">Авто-правки</option>
              <option value="full">Полный доступ</option>
            </select>
          </label>
        </div>
        <p className="muted small-text">Права применяются к новым сессиям. Модель перезапускается при смене файла, контекста, адреса или режима ускорения.</p>
      </div>
      <div className="modal-actions">
        <button className="ghost" onClick={close}>
          Отмена
        </button>
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
    </Modal>
  );
}
