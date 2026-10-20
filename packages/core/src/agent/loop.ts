import type { ChatMessage, ContentPart, InferenceBackend, ToolCall } from '../inference/backend.ts';
import { compactHistory, totalTokens } from '../context/compact.ts';
import { truncateMiddle } from '../context/truncate.ts';
import type { PermissionPolicy } from '../permissions/policy.ts';
import { detectSandbox, type SandboxRunner } from '../sandbox/index.ts';
import type { SessionStore } from '../session/store.ts';
import type { SkillCatalog } from '../skills/catalog.ts';
import type { SnapshotStore } from '../snapshot/store.ts';
import { isInside } from '../tools/paths.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext, ToolResult } from '../tools/types.ts';
import { validateArgs } from '../tools/validate.ts';
import type { AgentEvent, ApprovalAnswer, ApprovalRequest, SessionStats } from './events.ts';
import { buildSystemPrompt } from './prompt.ts';
import { NativeStrategy, SchemaStrategy, type Strategy, type ToolCallMode } from './strategy.ts';

export type SkillRouting = 'model' | 'explicit' | 'auto';

export interface AgentOptions {
  backend: InferenceBackend;
  cwd: string;
  registry: ToolRegistry;
  policy: PermissionPolicy;
  /** Запрос подтверждения у пользователя. Без него все `ask` отклоняются. */
  approve?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  sessionId?: string;
  store?: SessionStore;
  snapshots?: SnapshotStore;
  skills?: SkillCatalog;
  sandbox?: SandboxRunner;
  toolCallMode?: ToolCallMode;
  /** model: только инструмент skill; explicit: плюс `/имя`; auto: плюс подбор по тексту запроса ядром. */
  skillRouting?: SkillRouting;
  contextSize?: number;
  maxSteps?: number;
  /** Подряд неудачных вызовов инструмента, после которых ход прекращается. */
  maxInvalidCalls?: number;
  maxTokens?: number;
  temperature?: number;
  toolOutputChars?: number;
  /** Дополнительный текст в системный промпт (например, правила проекта). */
  systemExtra?: string;
}

const DENIED_HINT = 'Do not retry the same action. Choose another approach or explain to the user what you need.';

export class Agent {
  readonly sessionId: string;
  readonly messages: ChatMessage[] = [];
  readonly stats: SessionStats = { steps: 0, toolCalls: 0, invalidCalls: 0, promptTokens: 0, generatedTokens: 0, genTokensPerSecond: 0 };
  readonly ctx: ToolContext;
  readonly backend: InferenceBackend;
  private readonly o: Required<Pick<AgentOptions, 'contextSize' | 'maxSteps' | 'maxInvalidCalls' | 'maxTokens' | 'temperature' | 'toolOutputChars'>> & AgentOptions;
  private readonly strategy: Strategy;
  private system: string;
  private genSpeedSamples: number[] = [];
  private notices: string[] = [];
  /** Последнее известное число токенов контекста по данным движка. */
  private lastContextTokens = 0;
  private lastContextMessages = 0;

  constructor(opts: AgentOptions) {
    this.o = { contextSize: 16384, maxSteps: 25, maxInvalidCalls: 3, maxTokens: 1536, temperature: 0, toolOutputChars: 8000, ...opts };
    this.sessionId = opts.sessionId ?? 'session';
    this.backend = opts.backend;
    this.strategy = (opts.toolCallMode ?? 'native') === 'schema' ? new SchemaStrategy() : new NativeStrategy();
    const routed = (opts.skillRouting ?? 'auto') !== 'model';
    this.system = buildSystemPrompt({ cwd: opts.cwd, ...(opts.skills ? { skills: opts.skills } : {}), listSkills: !routed || undefined, ...(opts.systemExtra ? { extra: opts.systemExtra } : {}) });
    if (opts.skills && routed && opts.skills.size > 0) {
      this.system += `\n\nInstalled skills: ${opts.skills.list().map((s) => s.name).join(', ')}. The user can start a message with /<name> to apply one.`;
    }
    this.ctx = {
      cwd: opts.cwd,
      sessionId: this.sessionId,
      ...(opts.snapshots ? { snapshots: opts.snapshots } : {}),
      ...(opts.skills ? { skills: opts.skills } : {}),
      sandbox: opts.sandbox ?? detectSandbox(),
      todos: [],
    };
    if (opts.store && opts.sessionId) this.messages.push(...opts.store.load(opts.sessionId));
  }

  /** Сообщает модели о событии вне диалога (например, пользователь откатил правки): текст присоединится к следующему сообщению. */
  addNotice(text: string): void {
    this.notices.push(text);
  }

  /** Убирает последние `n` ходов пользователя из истории (после отката файлов). */
  dropLastTurns(n: number): void {
    for (let k = 0; k < n; k++) {
      let i = this.messages.length - 1;
      while (i >= 0 && this.messages[i]!.role !== 'user') i--;
      if (i < 0) return;
      this.messages.length = i;
    }
    this.lastContextTokens = 0;
    if (this.o.store && this.o.sessionId) this.o.store.rewrite(this.o.sessionId, this.messages);
  }

  get systemPrompt(): string {
    return this.system;
  }

  /** Токены контекста: данные движка с поправкой на сообщения, добавленные после последнего ответа. */
  contextTokens(): number {
    if (this.lastContextTokens > 0 && this.lastContextMessages <= this.messages.length) {
      return this.lastContextTokens + totalTokens(this.messages.slice(this.lastContextMessages));
    }
    return totalTokens(this.messages) + Math.ceil(this.system.length / 3.6);
  }

  private push(m: ChatMessage): void {
    this.messages.push(m);
    if (this.o.store && this.o.sessionId) this.o.store.append(this.o.sessionId, m);
  }

  /** Один ход пользователя: цикл «модель — инструмент — результат» до ответа без вызова. */
  async *send(input: string | ContentPart[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const text = typeof input === 'string' ? input : input.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join(' ');
    this.o.snapshots?.begin(text.slice(0, 80));

    const routed = this.routeSkill(text);
    let userContent: string | ContentPart[] = input;
    if (routed) {
      yield { type: 'skill_loaded', name: routed.skill.name, via: routed.via };
      const block = `\n\n[Skill "${routed.skill.name}" is loaded. Follow its instructions.]\n${routed.skill.body}`;
      userContent = typeof input === 'string' ? `${routed.text}${block}` : [...input, { type: 'text', text: block }];
      if (routed.skill.scope === 'project') this.o.policy.markTainted();
    }
    if (this.notices.length) {
      const note = `[Note: ${this.notices.join(' ')}]\n\n`;
      this.notices = [];
      userContent = typeof userContent === 'string' ? note + userContent : [{ type: 'text', text: note }, ...userContent];
    }
    this.push({ role: 'user', content: userContent });

    let invalidStreak = 0;
    let lastSig = '';
    let sameCount = 0;

    for (let step = 1; step <= this.o.maxSteps; step++) {
      if (signal?.aborted) {
        yield { type: 'done', reason: 'aborted', steps: step - 1 };
        return;
      }
      yield* this.maybeCompact();

      let turnText = '';
      const calls: ToolCall[] = [];
      try {
        const req = this.strategy.request(this.system, this.messages, this.o.registry.definitions(), { maxTokens: this.o.maxTokens, temperature: this.o.temperature });
        for await (const chunk of this.o.backend.chat(req, signal)) {
          if (chunk.type === 'text') {
            turnText += chunk.delta;
            if (this.strategy.streamsText) yield { type: 'text', delta: chunk.delta };
          } else if (chunk.type === 'reasoning') yield { type: 'reasoning', delta: chunk.delta };
          else if (chunk.type === 'toolCall') calls.push(chunk.call);
          else if (chunk.type === 'done' && chunk.timings) {
            this.recordTimings(chunk.timings);
            yield { type: 'timings', timings: chunk.timings };
          }
        }
      } catch (e) {
        if (signal?.aborted) {
          yield { type: 'done', reason: 'aborted', steps: step - 1 };
          return;
        }
        yield { type: 'done', reason: 'error', steps: step - 1, message: (e as Error).message };
        return;
      }
      this.lastContextMessages = this.messages.length + 1;
      this.stats.steps++;

      const turn = this.strategy.finish(turnText, calls);
      if (turn.malformed) {
        this.push({ role: 'assistant', content: turn.text });
        this.push({ role: 'user', content: 'Your reply was not valid JSON of the required form. Reply with {"tool": ..., "arguments": {...}}.' });
        if (++invalidStreak >= this.o.maxInvalidCalls) {
          yield { type: 'done', reason: 'invalid_tool_calls', steps: step };
          return;
        }
        continue;
      }
      if (!this.strategy.streamsText && turn.text) yield { type: 'text', delta: turn.text };

      this.push({ role: 'assistant', content: turn.text, ...(turn.calls.length ? { toolCalls: turn.calls } : {}) });
      if (turn.calls.length === 0) {
        yield { type: 'done', reason: 'completed', steps: step };
        return;
      }

      for (const call of turn.calls) {
        const sig = `${call.name}:${call.arguments}`;
        sameCount = sig === lastSig ? sameCount + 1 : 1;
        lastSig = sig;
        if (sameCount >= 5) {
          this.push({ role: 'tool', toolCallId: call.id, content: 'Repeated the same call too many times. Stopping.' });
          yield { type: 'done', reason: 'loop_detected', steps: step };
          return;
        }

        const outcome = yield* this.runCall(call, sameCount >= 3, signal);
        if (outcome === 'invalid') {
          if (++invalidStreak >= this.o.maxInvalidCalls) {
            yield { type: 'done', reason: 'invalid_tool_calls', steps: step };
            return;
          }
        } else invalidStreak = 0;
        if (signal?.aborted) {
          yield { type: 'done', reason: 'aborted', steps: step };
          return;
        }
      }
    }
    yield { type: 'done', reason: 'max_steps', steps: this.o.maxSteps };
  }

  private routeSkill(text: string): { skill: import('../skills/catalog.ts').Skill; via: 'command' | 'match'; text: string } | undefined {
    const mode = this.o.skillRouting ?? 'auto';
    const cat = this.o.skills;
    if (!cat || mode === 'model') return undefined;
    const cmd = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (cmd) {
      const skill = cat.get(cmd[1]!);
      if (skill) return { skill, via: 'command', text: (cmd[2] ?? '').trim() || `Apply the ${skill.name} skill.` };
    }
    if (mode === 'auto') {
      const skill = cat.match(text);
      if (skill) return { skill, via: 'match', text };
    }
    return undefined;
  }

  private recordTimings(t: { promptTokens: number; cachedTokens: number; predictedTokens: number; predictedTokensPerSecond: number }): void {
    this.lastContextTokens = t.promptTokens + t.cachedTokens + t.predictedTokens;
    this.stats.promptTokens += t.promptTokens;
    this.stats.generatedTokens += t.predictedTokens;
    if (t.predictedTokens >= 8 && t.predictedTokensPerSecond > 0) {
      this.genSpeedSamples.push(t.predictedTokensPerSecond);
      this.stats.genTokensPerSecond = this.genSpeedSamples.reduce((a, b) => a + b, 0) / this.genSpeedSamples.length;
    }
  }

  private async *maybeCompact(): AsyncGenerator<AgentEvent> {
    const limit = Math.floor(this.o.contextSize * 0.72);
    if (this.contextTokens() <= limit) return;
    const systemTokens = Math.ceil(this.system.length / 3.6) + 600;
    const r = compactHistory(this.messages, Math.floor(this.o.contextSize * 0.5) - systemTokens);
    if (r.stage === 'none') return;
    this.messages.splice(0, this.messages.length, ...r.messages);
    if (this.o.store && this.o.sessionId) this.o.store.rewrite(this.o.sessionId, this.messages);
    // История сменилась: оценка движка устарела.
    this.lastContextTokens = 0;
    yield { type: 'compaction', stage: r.stage, before: r.before, after: r.after };
  }

  /** Валидация, права, выполнение одного вызова. Возвращает 'invalid' для ошибок формата вызова. */
  private async *runCall(call: ToolCall, repeated: boolean, signal?: AbortSignal): AsyncGenerator<AgentEvent, 'ok' | 'invalid'> {
    const tool = this.o.registry.get(call.name);
    this.stats.toolCalls++;
    if (!tool) {
      this.stats.invalidCalls++;
      const error = `Unknown tool "${call.name}". Available tools: ${this.o.registry.names().join(', ')}.`;
      this.push({ role: 'tool', toolCallId: call.id, content: error });
      yield { type: 'invalid_call', name: call.name, error, attempt: this.stats.invalidCalls };
      return 'invalid';
    }
    const v = validateArgs(tool.parameters, call.arguments, tool.name);
    if (!v.ok) {
      this.stats.invalidCalls++;
      this.push({ role: 'tool', toolCallId: call.id, content: v.error });
      yield { type: 'invalid_call', name: call.name, error: v.error, attempt: this.stats.invalidCalls };
      return 'invalid';
    }
    const intent = tool.inspect(v.args, this.ctx);
    yield { type: 'tool_call', id: call.id, name: call.name, summary: intent.summary, args: v.args };

    if (repeated) {
      this.push({ role: 'tool', toolCallId: call.id, content: 'You already made this exact call several times with the same result. Try something different or finish.' });
      yield { type: 'tool_result', id: call.id, name: call.name, content: 'repeated call', isError: true, touched: [], ms: 0 };
      return 'ok';
    }

    let decision = this.o.policy.decide(tool, v.args, intent);
    if (decision.action === 'ask') {
      let answer: ApprovalAnswer = 'deny';
      if (this.o.approve) {
        answer = await this.o.approve({
          tool: tool.name,
          summary: intent.summary,
          reason: decision.reason,
          ...(call.name === 'shell' ? { detail: String(v.args.command ?? '') } : {}),
          ...(decision.grantLabel ? { grantLabel: decision.grantLabel } : {}),
        });
      }
      yield { type: 'approval', id: call.id, answer: this.o.approve ? answer : 'auto-denied', reason: decision.reason };
      if (answer === 'allow-session' && decision.grantKey) this.o.policy.grant(decision.grantKey);
      decision = answer === 'deny' ? { action: 'deny', reason: 'The user declined this action.' } : { action: 'allow' };
    }
    if (decision.action === 'deny') {
      const content = `Denied: ${decision.reason} ${DENIED_HINT}`;
      this.push({ role: 'tool', toolCallId: call.id, content });
      yield { type: 'tool_result', id: call.id, name: call.name, content, isError: true, touched: [], ms: 0 };
      return 'ok';
    }

    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await tool.run(v.args, { ...this.ctx, ...(signal ? { signal } : {}) });
    } catch (e) {
      result = { content: `Tool crashed: ${(e as Error).message}`, isError: true };
    }
    const outside = (intent.paths ?? []).some((p) => !isInside(this.ctx.cwd, p));
    if (result.untrusted || (tool.risk === 'read' && outside) || tool.risk === 'external') this.o.policy.markTainted();
    const content = truncateMiddle(result.content, this.o.toolOutputChars);
    this.push({ role: 'tool', toolCallId: call.id, content });
    yield { type: 'tool_result', id: call.id, name: call.name, content, isError: result.isError === true, touched: result.touched ?? [], ms: Date.now() - t0 };
    return 'ok';
  }
}
