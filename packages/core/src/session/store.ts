import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '../inference/backend.ts';

export interface SessionInfo {
  id: string;
  updatedAt: number;
  title: string;
}

/** Сессии лежат построчным JSON в проекте: просто читать, просто чинить; перенос в SQLite запланирован на M2. */
export class SessionStore {
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.gemmacode', 'sessions');
  }

  private file(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  static newId(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
  }

  append(id: string, message: ChatMessage): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(id), `${JSON.stringify(message)}\n`);
  }

  /** Заменяет историю после сжатия: старый файл остаётся как архив. */
  load(id: string): ChatMessage[] {
    if (!existsSync(this.file(id))) return [];
    const out: ChatMessage[] = [];
    for (const line of readFileSync(this.file(id), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ChatMessage);
      } catch {
        // оборванная последняя строка после сбоя
      }
    }
    return out;
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const id = f.slice(0, -6);
        const first = this.load(id).find((m) => m.role === 'user');
        const title = first && typeof first.content === 'string' ? first.content.slice(0, 80) : '';
        return { id, updatedAt: statSync(join(this.dir, f)).mtimeMs, title };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
