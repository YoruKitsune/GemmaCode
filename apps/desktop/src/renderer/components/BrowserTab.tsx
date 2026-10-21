import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserInputWire, BrowserState } from '@gemmacode/protocol';
import { bridge } from '../bridge';
import { abort } from '../actions';
import { browserBus } from '../events';
import { setState, toast, useStore } from '../store';
import { IconBack, IconClose, IconForward, IconGlobe, IconPlus, IconReload, IconStop } from './icons';

const MODS = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

/**
 * Встроенный браузер. Страницы живут в сервисе агента (Chromium под управлением CDP), окно показывает их кадры и
 * отправляет ввод пользователя. Пока агент работает в браузере, пользователь может перехватить управление: клики и ввод идут в ту же страницу.
 */
export function BrowserTab({ visible }: { visible: boolean }) {
  const browser = useStore((s) => s.browser);
  const project = useStore((s) => s.project?.path);
  const agentBusy = useStore((s) => {
    const f = s.session?.feed;
    const last = f && f.length ? f[f.length - 1] : undefined;
    return Boolean(s.session?.running && last && last.kind === 'tool' && last.name === 'browser' && last.status === 'running');
  });
  const area = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const frame = useRef({ w: 1024, h: 768 });
  const [url, setUrl] = useState('');
  const editing = useRef(false);
  const [blank, setBlank] = useState(true);

  const active = browser?.tabs.find((t) => t.id === browser.active);

  // адресная строка следует за страницей, пока пользователь в неё не печатает
  useEffect(() => {
    if (!editing.current) setUrl(active?.url && active.url !== 'about:blank' ? active.url : '');
  }, [active?.url]);

  const size = (): { width: number; height: number } => {
    const r = area.current?.getBoundingClientRect();
    return { width: Math.max(320, Math.round(r?.width ?? 800)), height: Math.max(240, Math.round(r?.height ?? 600)) };
  };

  // вкладка видна: сервис шлёт кадры; скрыта или закрыта: останавливает
  useEffect(() => {
    if (!visible || !project) return;
    let cancelled = false;
    bridge.call('browser.attach', size()).then(
      (st) => !cancelled && setState({ browser: st }),
      (e) => toast(e instanceof Error ? e.message : String(e), 'error'),
    );
    return () => {
      cancelled = true;
      void bridge.call('browser.detach', {}).catch(() => undefined);
    };
  }, [visible, project]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ data: string; width: number; height: number }>).detail;
      if (!img.current) return;
      frame.current = { w: d.width, h: d.height };
      img.current.src = `data:image/jpeg;base64,${d.data}`;
      setBlank(false);
    };
    browserBus.addEventListener('frame', on);
    return () => browserBus.removeEventListener('frame', on);
  }, []);

  // страница подстраивается под размер панели
  useEffect(() => {
    const el = area.current;
    if (!el || !visible) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => void bridge.call('browser.viewport', size()).catch(() => undefined), 200);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [visible]);

  const send = useCallback((ev: BrowserInputWire) => void bridge.call('browser.input', ev).catch(() => undefined), []);
  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * frame.current.w), y: Math.round(((e.clientY - r.top) / r.height) * frame.current.h) };
  };

  // колесо должно уметь отменять прокрутку панели, а React вешает пассивные слушатели
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send({ kind: 'wheel', ...toPage(e), dx: e.deltaX, dy: e.deltaY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [send, visible]);

  const call = async (p: Promise<BrowserState>) => {
    try {
      setState({ browser: await p });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const go = () => {
    editing.current = false;
    if (url.trim()) void call(bridge.call('browser.open', { url: url.trim() }));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      void navigator.clipboard.readText().then((text) => text && send({ kind: 'text', text }), () => undefined);
      return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    e.preventDefault();
    send({ kind: 'key', key: e.key, code: e.code, modifiers: MODS(e) });
  };

  if (browser && !browser.available) {
    return (
      <div className="pad browser-off">
        <IconGlobe size={28} />
        <p>Встроенный браузер недоступен.</p>
        <p className="muted small-text">{browser.reason ?? 'Не удалось запустить Chromium.'}</p>
      </div>
    );
  }

  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist">
        {(browser?.tabs ?? []).map((t) => (
          <span key={t.id} role="tab" aria-selected={t.id === browser?.active} className={`btab${t.id === browser?.active ? ' active' : ''}`} onClick={() => void call(bridge.call('browser.tab', { action: 'activate', id: t.id }))} title={t.url}>
            <span className="btab-title">{t.title || (t.url === 'about:blank' ? 'Новая вкладка' : t.url)}</span>
            <button className="icon tiny" aria-label="Закрыть вкладку" onClick={(e) => (e.stopPropagation(), void call(bridge.call('browser.tab', { action: 'close', id: t.id })))}>
              <IconClose size={11} />
            </button>
          </span>
        ))}
        <button className="icon tiny" aria-label="Новая вкладка" title="Новая вкладка" onClick={() => void call(bridge.call('browser.tab', { action: 'new' }))}>
          <IconPlus size={13} />
        </button>
      </div>
      <div className="browser-bar">
        <button className="icon" aria-label="Назад" disabled={!active?.canGoBack} onClick={() => void call(bridge.call('browser.nav', { action: 'back' }))}><IconBack size={15} /></button>
        <button className="icon" aria-label="Вперёд" disabled={!active?.canGoForward} onClick={() => void call(bridge.call('browser.nav', { action: 'forward' }))}><IconForward size={15} /></button>
        <button className="icon" aria-label="Обновить" onClick={() => void call(bridge.call('browser.nav', { action: active?.loading ? 'stop' : 'reload' }))}>{active?.loading ? <IconClose size={14} /> : <IconReload size={15} />}</button>
        <input
          className="browser-url"
          aria-label="Адрес"
          placeholder="Адрес сайта, localhost:порт или файл проекта"
          value={url}
          spellCheck={false}
          onFocus={(e) => ((editing.current = true), e.currentTarget.select())}
          onBlur={() => (editing.current = false)}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
      </div>
      {agentBusy && (
        <div className="browser-agent">
          <span className="pulse" /> Агент управляет браузером. Можно перехватить: клики и ввод идут в ту же страницу.
          <button className="small" onClick={() => void abort()}><IconStop size={11} /> Остановить</button>
        </div>
      )}
      <div className="browser-view" ref={area}>
        {active?.loading && <div className="browser-progress" />}
        <img
          ref={img}
          className="browser-frame"
          alt="Страница во встроенном браузере"
          draggable={false}
          tabIndex={0}
          hidden={blank}
          onClick={(e) => {
            (e.currentTarget as HTMLElement).focus();
            send({ kind: 'click', ...toPage(e) });
          }}
          onDoubleClick={(e) => send({ kind: 'click', ...toPage(e), count: 2 })}
          onContextMenu={(e) => (e.preventDefault(), send({ kind: 'click', ...toPage(e), button: 'right' }))}
          onKeyDown={onKey}
        />
        {blank && (
          <div className="browser-empty">
            <IconGlobe size={30} />
            <p>Введите адрес выше или попросите агента открыть страницу.</p>
            <p className="muted small-text">Профиль отдельный: ваши входы в сайты сюда не попадают.</p>
          </div>
        )}
      </div>
    </div>
  );
}
