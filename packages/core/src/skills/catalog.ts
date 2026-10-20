import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';

export interface Skill {
  name: string;
  description: string;
  /** Каталог скилла (рядом с SKILL.md могут лежать скрипты и шаблоны). */
  dir: string;
  scope: 'user' | 'project';
  /** Тело инструкции без заголовка. */
  body: string;
}

const MAX_BODY_CHARS = 12_000;

/** Каталоги скиллов. Форматы других агентов (`.claude/skills`, `.agents/skills`) читаются для совместимости. */
export function skillRoots(cwd: string, home = homedir()): { dir: string; scope: Skill['scope'] }[] {
  return [
    { dir: join(home, '.gemmacode', 'skills'), scope: 'user' },
    { dir: join(home, '.claude', 'skills'), scope: 'user' },
    { dir: join(home, '.agents', 'skills'), scope: 'user' },
    { dir: join(cwd, '.claude', 'skills'), scope: 'project' },
    { dir: join(cwd, '.agents', 'skills'), scope: 'project' },
    { dir: join(cwd, '.gemmacode', 'skills'), scope: 'project' },
  ];
}

export class SkillCatalog {
  private readonly skills = new Map<string, Skill>();

  /** Позже загруженные каталоги перекрывают более ранние, поэтому проектные скиллы главнее пользовательских. */
  static load(cwd: string, home = homedir()): SkillCatalog {
    const cat = new SkillCatalog();
    for (const root of skillRoots(cwd, home)) {
      if (!existsSync(root.dir)) continue;
      for (const entry of readdirSync(root.dir)) {
        const dir = join(root.dir, entry);
        const file = join(dir, 'SKILL.md');
        try {
          if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
          const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
          const name = (data.name || basename(dir)).trim();
          if (!/^[\w.-]+$/.test(name)) continue;
          cat.skills.set(name, {
            name,
            description: (data.description || '').replace(/\s+/g, ' ').trim(),
            dir,
            scope: root.scope,
            body: body.trim().slice(0, MAX_BODY_CHARS),
          });
        } catch {
          // повреждённый скилл пропускаем
        }
      }
    }
    return cat;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  get size(): number {
    return this.skills.size;
  }

  /** Строки для системного промпта: только имя и короткое описание. */
  promptListing(maxDescChars = 110): string {
    return this.list()
      .map((s) => `- ${s.name}: ${s.description.length > maxDescChars ? `${s.description.slice(0, maxDescChars - 1)}…` : s.description}`)
      .join('\n');
  }

  /**
   * Подбор скилла по тексту запроса без участия модели: пересечение слов запроса с именем и описанием.
   * Нужен потому, что E2B не вызывает инструмент `skill` по списку в промпте (M0: 0 из 4).
   */
  match(query: string, threshold = 0.5): Skill | undefined {
    const q = tokens(query);
    if (q.size === 0) return undefined;
    let best: { skill: Skill; score: number } | undefined;
    for (const s of this.skills.values()) {
      const doc = tokens(`${s.name.replace(/[-_]/g, ' ')} ${s.description}`);
      const nameWords = tokens(s.name.replace(/[-_]/g, ' '));
      let hit = 0;
      for (const w of nameWords) if (q.has(w)) hit += 2;
      for (const w of q) if (doc.has(w) && !nameWords.has(w)) hit += 1;
      const score = hit / Math.max(3, Math.min(q.size, 8) + nameWords.size);
      if (!best || score > best.score) best = { skill: s, score };
    }
    return best && best.score >= threshold ? best.skill : undefined;
  }
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'with', 'is', 'it', 'this', 'that', 'me', 'my', 'please', 'use', 'when', 'from', 'по', 'и', 'в', 'на', 'для', 'с', 'к', 'из', 'это', 'мне', 'мой', 'пожалуйста']);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.replace(/(ing|ed|es|s)$/, ''));
  }
  return out;
}
