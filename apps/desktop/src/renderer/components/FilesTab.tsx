import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { DirEntry, SearchHit } from '@gemmacode/protocol';
import { openFile, refreshGit } from '../actions';
import { bridge } from '../bridge';
import { composerBus } from '../events';
import { dirName } from '../format';
import { setState, toast, useStore } from '../store';
import { IconChevron, IconFile, IconFolder, IconPlus, IconSearch } from './icons';

interface Row {
  entry: DirEntry;
  depth: number;
}

interface Menu {
  x: number;
  y: number;
  entry: DirEntry | null;
}

const GIT_LABEL: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', '?': 'U' };

function gitBadge(status: string | undefined): { letter: string; cls: string } | null {
  if (!status) return null;
  const c = status.trim()[0] ?? '?';
  return { letter: GIT_LABEL[c] ?? c, cls: c === '?' || c === 'A' ? 'git-new' : c === 'D' ? 'git-del' : 'git-mod' };
}

export function FilesTab() {
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [query, setQuery] = useState('');
  const [content, setContent] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const project = useStore((s) => s.project?.path);
  const git = useStore((s) => s.git);
  const touched = useStore((s) => s.session?.touched);
  const fsVersion = useStore((s) => s.fsVersion);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = useCallback(async (dir: string) => {
    try {
      const entries = await bridge.call('fs.list', { dir });
      setDirs((d) => ({ ...d, [dir]: entries }));
    } catch {
      setDirs((d) => {
        const { [dir]: _gone, ...rest } = d;
        return rest;
      });
    }
  }, []);

  // новый проект — дерево с нуля
  useEffect(() => {
    setDirs({});
    setExpanded(new Set(['']));
    void loadDir('');
  }, [project, loadDir]);

  // файлы изменились — перечитываем раскрытые каталоги
  useEffect(() => {
    if (!fsVersion) return;
    const t = setTimeout(() => [...expandedRef.current].slice(0, 40).forEach((d) => void loadDir(d)), 250);
    return () => clearTimeout(t);
  }, [fsVersion, loadDir]);

  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => {
      bridge.call('fs.search', { query, mode: content ? 'content' : 'name' }).then(setHits, (e) => toast(String(e.message ?? e), 'error'));
    }, 160);
    return () => clearTimeout(t);
  }, [query, content]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const statusByPath = useMemo(() => new Map(git?.files.map((f) => [f.path, f.status]) ?? []), [git]);
  const dirtyDirs = useMemo(() => {
    const set = new Set<string>();
    for (const f of git?.files ?? []) for (let d = dirName(f.path); d; d = dirName(d)) set.add(d);
    return set;
  }, [git]);
  const touchedSet = useMemo(() => new Set(touched), [touched]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of dirs[dir] ?? []) {
        out.push({ entry, depth });
        if (entry.type === 'dir' && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [dirs, expanded]);

  const toggle = (e: DirEntry) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(e.path)) n.delete(e.path);
      else {
        n.add(e.path);
        void loadDir(e.path);
      }
      return n;
    });
  };

  const afterChange = () => {
    [...expandedRef.current].forEach((d) => void loadDir(d));
    void refreshGit();
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      afterChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const ask = (title: string, value: string, ok: string, fn: (v: string) => Promise<unknown>) =>
    setState({ prompt: { title, value, ok, run: (v) => void run(() => fn(v)) } });

  const parentOf = (e: DirEntry | null) => (!e ? '' : e.type === 'dir' ? e.path : dirName(e.path));
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  const contextMenu = (e: MouseEvent, entry: DirEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  return (
    <div className="files" onContextMenu={(e) => contextMenu(e, null)}>
      <div className="files-search">
        <IconSearch size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={content ? 'Поиск по содержимому' : 'Поиск по имени'} aria-label="Поиск по проекту" />
        <label className="check small-text" title="Искать внутри файлов">
          <input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} /> текст
        </label>
        <button className="icon" title="Новый файл" aria-label="Новый файл" onClick={() => ask('Новый файл', '', 'Создать', async (v) => (await bridge.call('fs.create', { path: join('', v.trim()) }), openFile(v.trim())))}>
          <IconPlus />
        </button>
      </div>
      {hits ? (
        <ul className="hits">
          {hits.length === 0 && <li className="muted pad">Ничего не найдено</li>}
          {hits.map((h, i) => (
            <li key={i} onClick={() => openFile(h.path)}>
              <span className="hit-path">{h.path}</span>
              {h.line && <span className="muted"> :{h.line}</span>}
              {h.text && <div className="hit-text">{h.text}</div>}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="tree" role="tree">
          {rows.map(({ entry, depth }) => {
            const open = expanded.has(entry.path);
            const badge = entry.type === 'file' ? gitBadge(statusByPath.get(entry.path)) : null;
            return (
              <li
                key={entry.path}
                role="treeitem"
                aria-expanded={entry.type === 'dir' ? open : undefined}
                className={`row${entry.muted ? ' muted-row' : ''}${touchedSet.has(entry.path) ? ' agent' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                draggable={entry.type === 'file'}
                onDragStart={(e) => e.dataTransfer.setData('application/x-gemmacode-path', entry.path)}
                onClick={() => (entry.type === 'dir' ? toggle(entry) : openFile(entry.path))}
                onContextMenu={(e) => contextMenu(e, entry)}
                title={entry.path}
              >
                {entry.type === 'dir' ? (
                  <>
                    <span className={`chev${open ? ' open' : ''}`}>
                      <IconChevron size={12} />
                    </span>
                    <IconFolder size={14} />
                  </>
                ) : (
                  <>
                    <span className="chev" />
                    <IconFile size={14} />
                  </>
                )}
                <span className="row-name">{entry.name}</span>
                {touchedSet.has(entry.path) && <span className="agent-dot" title="Изменён агентом в этой сессии" />}
                {entry.type === 'dir' && dirtyDirs.has(entry.path) && <span className="git-dot" />}
                {badge && <span className={`git ${badge.cls}`}>{badge.letter}</span>}
              </li>
            );
          })}
          {rows.length === 0 && <li className="muted pad">Папка пуста</li>}
        </ul>
      )}
      {menu && (
        <ul className="menu" style={{ left: menu.x, top: menu.y }} role="menu">
          {menu.entry?.type === 'file' && <li onClick={() => openFile(menu.entry!.path)}>Открыть</li>}
          {menu.entry?.type === 'file' && <li onClick={() => composerBus.dispatchEvent(new CustomEvent('attach', { detail: menu.entry!.path }))}>Прикрепить к сообщению</li>}
          <li onClick={() => ask('Новый файл', join(parentOf(menu.entry), ''), 'Создать', async (v) => (await bridge.call('fs.create', { path: v.trim() }), openFile(v.trim())))}>Новый файл…</li>
          <li onClick={() => ask('Новая папка', join(parentOf(menu.entry), ''), 'Создать', (v) => bridge.call('fs.create', { path: v.trim(), dir: true }))}>Новая папка…</li>
          {menu.entry && <li onClick={() => ask('Переименовать', menu.entry!.path, 'Переименовать', (v) => bridge.call('fs.rename', { from: menu.entry!.path, to: v.trim() }))}>Переименовать…</li>}
          {menu.entry && (
            <li
              className="danger"
              onClick={() =>
                setState({
                  confirm: {
                    title: 'Переместить в корзину?',
                    text: `${menu.entry!.path} будет перемещён в корзину системы.`,
                    ok: 'В корзину',
                    danger: true,
                    run: () => void run(() => bridge.call('fs.trash', { path: menu.entry!.path })),
                  },
                })
              }
            >
              В корзину…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

