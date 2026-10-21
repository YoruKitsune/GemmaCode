import { truncateMiddle, type RunnerEvent } from '@gemmacode/core';

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');

export interface Out {
  write(s: string): void;
}

/** Выводит события хода в терминал: текст потоком, вызовы инструментов строками, результаты сжато. */
export class Renderer {
  private readonly out: Out;
  private midLine = false;
  private readonly verbose: boolean;

  constructor(out: Out = process.stdout, verbose = false) {
    this.out = out;
    this.verbose = verbose;
  }

  private newline(): void {
    if (this.midLine) {
      this.out.write('\n');
      this.midLine = false;
    }
  }

  line(s: string): void {
    this.newline();
    this.out.write(`${s}\n`);
  }

  event(e: RunnerEvent): void {
    switch (e.type) {
      case 'text':
        this.out.write(e.delta);
        this.midLine = !e.delta.endsWith('\n');
        break;
      case 'reasoning':
        if (this.verbose) this.out.write(dim(e.delta));
        break;
      case 'iteration':
        if (e.n > 1) this.line(yellow(`↻ попытка ${e.n}/${e.max}: ${e.reason === 'verify_failed' ? 'проверка не прошла' : 'замечания ревью'}`));
        break;
      case 'skill_loaded':
        this.line(dim(`◆ скилл ${e.name}${e.via === 'match' ? ' (подобран по запросу)' : ''}`));
        break;
      case 'tool_call':
        this.line(`${cyan('●')} ${bold(e.name)} ${dim(e.summary)}`);
        if (e.name === 'edit_file') this.line(formatEdit(e.args));
        break;
      case 'approval':
        if (e.answer === 'auto-denied') this.line(red('  ✗ требуется подтверждение, но запросить некого — отклонено'));
        break;
      case 'tool_result': {
        const first = truncateMiddle(e.content.split('\n').find((l) => l.trim()) ?? '', 110);
        const more = e.content.split('\n').length - 1;
        this.line(`  ${e.isError ? red('✗') : green('✓')} ${dim(first)}${more > 0 ? dim(` (+${more} строк)`) : ''}`);
        break;
      }
      case 'fallback':
        this.line(dim(`↯ ${e.reason}`));
        break;
      case 'nudge':
        this.line(dim(`↯ ${e.reason}`));
        break;
      case 'invalid_call':
        this.line(`  ${yellow('!')} ${dim(truncateMiddle(e.error, 140))}`);
        break;
      case 'compaction':
        this.line(dim(`⇣ контекст сжат (${e.stage}): ${e.before} → ${e.after} токенов`));
        break;
      case 'verify':
        this.line(`${e.passed ? green('✔') : red('✘')} проверка ${dim(e.command)} ${e.passed ? 'прошла' : `не прошла (код ${e.exitCode})`}`);
        if (!e.passed && this.verbose) this.line(dim(e.output));
        break;
      case 'review':
        if (e.verdict === 'skipped') this.line(dim('⌕ ревью: изменений нет'));
        else if (e.verdict === 'ok') this.line(`${green('⌕')} ревью: замечаний нет${e.dropped ? dim(` (отброшено необоснованных: ${e.dropped})`) : ''}`);
        else for (const i of e.issues) this.line(`${yellow('⌕')} ревью: ${i.file ? `${i.file}: ` : ''}${i.problem}`);
        break;
      case 'done':
        this.newline();
        if (e.reason === 'max_steps') this.line(yellow('Достигнут лимит шагов.'));
        else if (e.reason === 'invalid_tool_calls') this.line(red('Модель несколько раз подряд выдала некорректные вызовы инструментов.'));
        else if (e.reason === 'loop_detected') this.line(red('Остановлено: модель повторяет один и тот же вызов.'));
        else if (e.reason === 'error') this.line(red(`Ошибка движка: ${e.message ?? ''}`));
        else if (e.reason === 'aborted') this.line(yellow('Прервано.'));
        break;
      case 'run_done':
        if (e.outcome === 'max_iterations') this.line(yellow(`Проверка так и не прошла за ${e.iterations} попыток.`));
        if (e.outcome === 'no_progress') this.line(yellow('Остановлено: правки не меняют результат проверки.'));
        break;
      default:
        break;
    }
  }
}

/** Компактный diff для edit_file: удалённые и добавленные строки. */
export function formatEdit(args: Record<string, unknown>): string {
  const lines = (s: unknown, sign: string, paint: (x: string) => string): string[] =>
    String(s ?? '').split('\n').slice(0, 6).map((l) => paint(`    ${sign} ${l}`));
  return [...lines(args.old_string, '-', red), ...lines(args.new_string, '+', green)].join('\n');
}
