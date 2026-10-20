import { estimateTokens, detectVerifyCommand, type PermissionMode } from '@gemmacode/core';
import type { Session } from './session.ts';
import { dim } from './render.ts';

export interface ReplState {
  verify: string | undefined;
  review: boolean;
  maxIterations: number;
}

export const HELP_COMMANDS = `Команды:
  /help               эта справка
  /mode [режим]       права: read-only, ask, auto-edit, full
  /verify [cmd|auto|off]  проверка для режима loop (тесты и т. п.)
  /review [on|off]    само-ревью правок после каждой задачи
  /diff               изменения последней задачи
  /undo               откатить файлы последней задачи
  /skills             установленные скиллы (применить: /имя запрос)
  /mcp                подключённые MCP-серверы
  /context            занятость контекста
  /stats              статистика сессии
  /sessions           сохранённые сессии (продолжить: gemmacode --resume ID)
  /exit               выход`;

export interface CommandResult {
  output: string;
  exit?: boolean;
}

const MODES: PermissionMode[] = ['read-only', 'ask', 'auto-edit', 'full'];

/** Обрабатывает слэш-команду. Возвращает null, если это не команда (а скилл или обычный текст). */
export function runCommand(input: string, s: Session, st: ReplState): CommandResult | null {
  const m = /^\/(\S+)\s*(.*)$/.exec(input.trim());
  if (!m) return null;
  const name = m[1]!;
  const arg = m[2]!.trim();
  switch (name) {
    case 'help':
    case '?':
      return { output: HELP_COMMANDS };
    case 'exit':
    case 'quit':
      return { output: '', exit: true };
    case 'mode': {
      if (!arg) return { output: `Режим прав: ${s.policy.mode}. Доступно: ${MODES.join(', ')}` };
      if (!MODES.includes(arg as PermissionMode)) return { output: `Неизвестный режим. Доступно: ${MODES.join(', ')}` };
      s.policy.mode = arg as PermissionMode;
      return { output: `Режим прав: ${arg}${arg === 'full' ? ' (команды и правки без подтверждения; песочница ОС остаётся)' : ''}` };
    }
    case 'verify': {
      if (!arg) return { output: st.verify ? `Проверка: ${st.verify}` : 'Проверка выключена. Включить: /verify npm test, либо /verify auto' };
      if (arg === 'off') {
        st.verify = undefined;
        return { output: 'Проверка выключена.' };
      }
      if (arg === 'auto') {
        const cmd = detectVerifyCommand(s.cwd);
        if (!cmd) return { output: 'Не нашёл команду проверки в проекте. Укажите её явно: /verify npm test' };
        st.verify = cmd;
        return { output: `Проверка: ${cmd}` };
      }
      st.verify = arg;
      return { output: `Проверка: ${arg}. После каждой задачи агент будет чинить, пока она не пройдёт (до ${st.maxIterations} попыток).` };
    }
    case 'review': {
      if (arg === 'on') st.review = true;
      else if (arg === 'off') st.review = false;
      else if (arg) return { output: 'Используйте /review on или /review off' };
      return { output: `Само-ревью: ${st.review ? 'включено' : 'выключено'}` };
    }
    case 'diff': {
      const last = s.snapshots.list().at(-1);
      if (!last) return { output: 'Пока нет изменений.' };
      return { output: s.snapshots.diffSince(last.id) || 'В последней задаче файлы не менялись.' };
    }
    case 'undo': {
      const last = s.snapshots.list().at(-1);
      if (!last) return { output: 'Откатывать нечего.' };
      const files = s.snapshots.rollbackTo(last.id);
      s.agent.dropLastTurns(1);
      if (files.length) s.agent.addNotice(`The user reverted your last changes, these files were restored: ${files.join(', ')}.`);
      return { output: files.length ? `Откатил: ${files.join(', ')}` : 'В последней задаче файлы не менялись; сообщение убрано из истории.' };
    }
    case 'skills': {
      const list = s.skills.list();
      return { output: list.length ? list.map((k) => `/${k.name}  ${dim(k.description)}  ${dim(`[${k.scope}]`)}`).join('\n') : 'Скиллов нет. Положите SKILL.md в ~/.gemmacode/skills/<имя>/ или .gemmacode/skills/<имя>/ проекта.' };
    }
    case 'mcp': {
      const info = s.mcp.info();
      return { output: info.length ? info.map((i) => `${i.name}: ${i.status}${i.error ? ` (${i.error})` : ''}${i.tools.length ? ` — ${i.tools.join(', ')}` : ''}${i.skipped ? ` (+${i.skipped} не подключено, лимит)` : ''}`).join('\n') : 'MCP-серверы не настроены ("mcpServers" в конфиге).' };
    }
    case 'context': {
      const used = s.agent.contextTokens();
      const limit = s.config.contextSize;
      return { output: `Контекст: ~${used} из ${limit} токенов (${Math.round((used / limit) * 100)}%), системный промпт ~${estimateTokens(s.agent.systemPrompt)}` };
    }
    case 'stats': {
      const t = s.agent.stats;
      return { output: `Шагов ${t.steps}, вызовов ${t.toolCalls} (невалидных ${t.invalidCalls}), токенов промпта ${t.promptTokens}, сгенерировано ${t.generatedTokens}, скорость ${t.genTokensPerSecond.toFixed(1)} ток/с` };
    }
    case 'sessions': {
      const list = s.store.list().slice(0, 10);
      return { output: list.length ? list.map((x) => `${x.id}  ${dim(x.title)}`).join('\n') : 'Сессий нет.' };
    }
    default:
      // /имя скилла обрабатывает агент; неизвестное имя тоже уйдёт ему как обычный текст
      return s.skills.get(name) ? null : { output: `Неизвестная команда /${name}. /help — список.` };
  }
}
