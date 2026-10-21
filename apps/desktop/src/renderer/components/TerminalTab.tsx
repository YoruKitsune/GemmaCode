import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge';
import { termBus } from '../events';
import { toast, useStore } from '../store';
import { IconClose, IconPlus } from './icons';

interface Term {
  key: number;
  hostId: string;
  title: string;
  xterm: Terminal;
  fit: FitAddon;
  exited: boolean;
}

function themeFromCss(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { background: v('--bg-editor'), foreground: v('--text'), cursor: v('--accent'), selectionBackground: v('--selection') };
}

/** Терминалы пользователя в корне проекта. Живут, пока открыт проект, и не пересоздаются при смене вкладки. */
export function TerminalTab({ visible }: { visible: boolean }) {
  const project = useStore((s) => s.project?.path);
  const [terms, setTerms] = useState<Term[]>([]);
  const [active, setActive] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Term[]>([]);
  termsRef.current = terms;
  const counter = useRef(0);

  const open = async () => {
    const el = host.current;
    if (!el) return;
    const xterm = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'), fontSize: 12.5, cursorBlink: true, theme: themeFromCss(), scrollback: 5000, allowProposedApi: false });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const key = ++counter.current;
    try {
      const container = document.createElement('div');
      container.className = 'xterm-host';
      container.dataset.key = String(key);
      el.appendChild(container);
      xterm.open(container);
      fit.fit();
      const { id, shell } = await bridge.call('term.open', { cols: xterm.cols, rows: xterm.rows });
      xterm.onData((d) => void bridge.call('term.write', { id, data: d }));
      xterm.onResize(({ cols, rows }) => void bridge.call('term.resize', { id, cols, rows }));
      const t: Term = { key, hostId: id, title: shell.split(/[\\/]/).pop() ?? 'shell', xterm, fit, exited: false };
      setTerms((x) => [...x, t]);
      setActive(key);
    } catch (e) {
      xterm.dispose();
      el.querySelector(`[data-key="${key}"]`)?.remove();
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  // данные из сервиса
  useEffect(() => {
    const onData = (e: Event) => {
      const { id, data } = (e as CustomEvent<{ id: string; data: string }>).detail;
      termsRef.current.find((t) => t.hostId === id)?.xterm.write(data);
    };
    const onExit = (e: Event) => {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      const t = termsRef.current.find((x) => x.hostId === id);
      t?.xterm.write('\r\n\x1b[2m[процесс завершён]\x1b[0m\r\n');
      setTerms((all) => all.map((x) => (x.hostId === id ? { ...x, exited: true } : x)));
    };
    termBus.addEventListener('term.data', onData);
    termBus.addEventListener('term.exit', onExit);
    return () => {
      termBus.removeEventListener('term.data', onData);
      termBus.removeEventListener('term.exit', onExit);
    };
  }, []);

  // смена проекта закрывает терминалы (сервис закрывает их сам)
  useEffect(() => {
    return () => {
      termsRef.current.forEach((t) => t.xterm.dispose());
      host.current?.replaceChildren();
      setTerms([]);
    };
  }, [project]);

  // первый заход на вкладку открывает терминал
  useEffect(() => {
    if (visible && project && termsRef.current.length === 0) void open();
  }, [visible, project]); // eslint-disable-line react-hooks/exhaustive-deps

  // подгонка размера
  useEffect(() => {
    const el = host.current;
    if (!el || !visible) return;
    const refit = () => {
      const t = termsRef.current.find((x) => x.key === active);
      try {
        t?.fit.fit();
      } catch {
        // вкладка скрыта
      }
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible, active, terms.length]);

  useEffect(() => {
    host.current?.querySelectorAll<HTMLElement>('.xterm-host').forEach((n) => (n.style.display = n.dataset.key === String(active) ? 'block' : 'none'));
    if (visible) termsRef.current.find((t) => t.key === active)?.xterm.focus();
  }, [active, terms.length, visible]);

  const close = (t: Term) => {
    void bridge.call('term.close', { id: t.hostId });
    t.xterm.dispose();
    host.current?.querySelector(`[data-key="${t.key}"]`)?.remove();
    const rest = termsRef.current.filter((x) => x.key !== t.key);
    setTerms(rest);
    setActive(rest.at(-1)?.key ?? 0);
  };

  return (
    <div className="terminal">
      <div className="term-tabs">
        {terms.map((t, i) => (
          <span key={t.key} className={`term-tab${t.key === active ? ' active' : ''}${t.exited ? ' exited' : ''}`} onClick={() => setActive(t.key)}>
            {t.title} {i + 1}
            <button className="icon tiny" onClick={(e) => (e.stopPropagation(), close(t))} aria-label="Закрыть терминал">
              <IconClose size={11} />
            </button>
          </span>
        ))}
        <button className="icon" onClick={() => void open()} title="Новый терминал" aria-label="Новый терминал">
          <IconPlus />
        </button>
      </div>
      <div className="term-host" ref={host} />
    </div>
  );
}
