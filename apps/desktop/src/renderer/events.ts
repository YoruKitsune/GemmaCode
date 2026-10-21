import { applyTurnEvent, type HostEvents, type TurnEvent } from '@gemmacode/protocol';
import { pickAndOpenProject, refreshChanges, refreshGit, showTab } from './actions';
import { bridge } from './bridge';
import { getState, setState, toast } from './store';

export const termBus = new EventTarget();
/** Кадры встроенного браузера: идут мимо хранилища, чтобы не перерисовывать окно на каждый кадр. */
export const browserBus = new EventTarget();
/** Команды композеру из других частей окна (например, «прикрепить к чату» в дереве файлов). */
export const composerBus = new EventTarget();

let queue: { sessionId: string; event: TurnEvent }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/** События модели приходят десятки раз в секунду; в ленту они сливаются не чаще раза в 40 мс. */
function flush(): void {
  timer = undefined;
  const batch = queue;
  queue = [];
  setState((s) => {
    if (!s.session) return {};
    let feed = s.session.feed;
    let speed = s.speed;
    for (const { sessionId, event } of batch) {
      if (sessionId !== s.session.id) continue;
      feed = applyTurnEvent(feed, event);
      if (event.type === 'timings' && event.timings.predictedTokens >= 8) speed = event.timings.predictedTokensPerSecond;
    }
    return { session: { ...s.session, feed }, speed };
  });
}

let browserShown = false;
let fsTimer: ReturnType<typeof setTimeout> | undefined;

export function startEvents(): () => void {
  return bridge.onEvent((name, data) => {
    switch (name) {
      case 'backend.status': {
        const d = data as HostEvents['backend.status'];
        setState({ backend: d });
        break;
      }
      case 'turn.start': {
        const d = data as HostEvents['turn.start'];
        browserShown = false;
        setState((s) => (s.session && s.session.id === d.sessionId ? { session: { ...s.session, feed: [...s.session.feed, d.item], running: true } } : {}));
        break;
      }
      case 'turn.event': {
        const d = data as HostEvents['turn.event'];
        // агент пошёл в браузер: показываем вкладку один раз за ход, чтобы было видно, что он делает
        if (d.event.type === 'tool_call' && d.event.name === 'browser' && !browserShown) {
          browserShown = true;
          if (getState().tab !== 'browser') showTab('browser');
        }
        queue.push(d);
        timer ??= setTimeout(flush, 40);
        break;
      }
      case 'turn.end': {
        const d = data as HostEvents['turn.end'];
        if (timer) {
          clearTimeout(timer);
          flush();
        }
        setState((s) =>
          s.session && s.session.id === d.sessionId
            ? { session: { ...s.session, running: false, stats: d.stats, context: d.context, checkpoints: d.checkpoints, touched: d.touched, title: d.title }, approvals: [] }
            : {},
        );
        void refreshChanges();
        void refreshGit();
        break;
      }
      case 'approval.request': {
        const d = data as HostEvents['approval.request'];
        setState((s) => (s.session && s.session.id === d.sessionId ? { approvals: [...s.approvals, d] } : {}));
        break;
      }
      case 'approval.resolved': {
        const d = data as HostEvents['approval.resolved'];
        setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== d.id) }));
        break;
      }
      case 'fs.changed': {
        const d = data as HostEvents['fs.changed'];
        setState((s) => ({ fsVersion: s.fsVersion + 1, fsPaths: d.paths }));
        clearTimeout(fsTimer);
        fsTimer = setTimeout(() => void refreshGit(), 400);
        break;
      }
      case 'sessions.changed': {
        const d = data as HostEvents['sessions.changed'];
        setState({ sessions: d.sessions });
        break;
      }
      case 'browser.state':
        setState({ browser: data as HostEvents['browser.state'] });
        break;
      case 'browser.frame':
        browserBus.dispatchEvent(new CustomEvent('frame', { detail: data }));
        break;
      case 'browser.blocked': {
        const d = data as HostEvents['browser.blocked'];
        toast(`Переход на ${d.url} заблокирован: ${d.reason.toLowerCase()}. Агент может запросить доступ командой open.`);
        break;
      }
      case 'term.data':
      case 'term.exit':
        termBus.dispatchEvent(new CustomEvent(name, { detail: data }));
        break;
      case 'host.crashed':
        toast('Сервис агента неожиданно завершился. Перезапустите приложение.', 'error');
        break;
      case 'ui.command':
        if ((data as { command: string }).command === 'open-project') void pickAndOpenProject();
        break;
    }
  });
}
