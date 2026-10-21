import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  /** Переписывает историю целиком (после отката ходов или сжатия). */
  rewrite(id: string, messages: readonly ChatMessage[]): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(id), messages.map((m) => `${JSON.stringify(m)}\n`).join(''));
  }

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

  delete(id: string): void {
    rmSync(this.file(id), { force: true });
  }

  /** Заголовок — начало первого сообщения пользователя. Читается только начало файла: история может быть большой. */
  private titleOf(file: string): string {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let m: ChatMessage;
        try {
          m = JSON.parse(line) as ChatMessage;
        } catch {
          continue;
        }
        if (m.role !== 'user') continue;
        const text = m.ui?.text ?? (typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' '));
        return text.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
    } catch {
      // файл пропал или не читается
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return '';
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = join(this.dir, f);
        return { id: f.slice(0, -6), updatedAt: statSync(file).mtimeMs, title: this.titleOf(file) };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
