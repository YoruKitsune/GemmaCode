import { createInterface } from 'node:readline/promises';
import { parseCli, HELP } from './args.ts';
import { runCommand, type ReplState } from './commands.ts';
import { Renderer, bold, dim, red, yellow } from './render.ts';
import { openSession, type Session } from './session.ts';
import { runTask, type ApprovalAnswer, type ApprovalRequest, type RunnerEvent } from '@gemmacode/core';

async function main(): Promise<number> {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const interactive = !opts.print && process.stdin.isTTY === true;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const render = new Renderer(process.stdout);

  const approve = rl
    ? async (r: ApprovalRequest): Promise<ApprovalAnswer> => {
        render.line(`${yellow('⚠')} ${bold(r.tool)}: ${r.summary}`);
        if (r.detail && r.detail !== r.summary) render.line(dim(`  ${r.detail}`));
        render.line(dim(`  Причина: ${r.reason}`));
        const hint = r.grantLabel ? `[y] да  [a] да, ${r.grantLabel}  [n] нет` : '[y] да  [n] нет';
        const ans = (await rl.question(`  ${hint} › `)).trim().toLowerCase();
        if (ans === 'a' && r.grantLabel) return 'allow-session';
        return ans === 'y' || ans === 'д' || ans === 'yes' || ans === 'да' ? 'allow' : 'deny';
      }
    : undefined;

  let session: Session;
  try {
    session = await openSession(opts, approve);
  } catch (e) {
    console.error(red((e as Error).message));
    rl?.close();
    return 2;
  }
  for (const w of session.warnings) console.error(yellow(`! ${w}`));
  if (!interactive && session.policy.mode !== 'full' && session.policy.mode !== 'auto-edit' && session.policy.mode !== 'read-only') {
    console.error(dim('Без терминала подтверждения недоступны: правки и команды будут отклонены. Используйте --mode auto-edit или --mode full.'));
  }

  const st: ReplState = {
    verify: session.config.verify,
    review: session.config.review,
    maxIterations: session.config.maxIterations,
  };
  const ac = { current: undefined as AbortController | undefined };
  process.on('SIGINT', () => {
    if (ac.current) ac.current.abort();
    else {
      void session.close().finally(() => process.exit(130));
    }
  });

  let exitCode = 0;
  const runOne = async (prompt: string): Promise<boolean> => {
    ac.current = new AbortController();
    let ok = true;
    try {
      for await (const e of runTask(session.agent, prompt, {
        ...(st.verify ? { verify: st.verify } : {}),
        ...(st.review ? { review: true } : {}),
        maxIterations: st.maxIterations,
      }, ac.current.signal)) {
        if (opts.json) console.log(JSON.stringify(e satisfies RunnerEvent));
        else render.event(e);
        if (e.type === 'run_done') ok = e.outcome === 'verified' || e.outcome === 'completed';
        if (e.type === 'done' && (e.reason === 'error' || e.reason === 'invalid_tool_calls' || e.reason === 'loop_detected')) ok = false;
      }
    } finally {
      ac.current = undefined;
    }
    return ok;
  };

  try {
    if (opts.print) {
      if (!opts.prompt) {
        console.error('С -p нужна задача: gemmacode -p "что сделать"');
        return 2;
      }
      return (await runOne(opts.prompt)) ? 0 : 1;
    }
    if (!interactive) {
      console.error('Нужен терминал. Для разовой задачи используйте: gemmacode -p "задача"');
      return 2;
    }
    console.log(`${bold('GemmaCode')} ${dim(`· ${session.cwd} · права: ${session.policy.mode} · контекст ${session.config.contextSize}`)}`);
    console.log(dim('/help — команды, Ctrl+C — прервать, /exit — выход'));
    if (opts.prompt) await runOne(opts.prompt);
    for (;;) {
      let line: string;
      try {
        line = (await rl!.question(`\n${bold('›')} `)).trim();
      } catch {
        break;
      }
      if (!line) continue;
      const cmd = runCommand(line, session, st);
      if (cmd) {
        if (cmd.output) console.log(cmd.output);
        if (cmd.exit) break;
        continue;
      }
      await runOne(line);
      const used = session.agent.contextTokens();
      console.log(dim(`[контекст ~${used}/${session.config.contextSize} · ${session.agent.stats.genTokensPerSecond.toFixed(1)} ток/с]`));
    }
  } catch (e) {
    console.error(red(`Ошибка: ${(e as Error).message}`));
    exitCode = 1;
  } finally {
    rl?.close();
    await session.close();
  }
  return exitCode;
}

process.exit(await main());
