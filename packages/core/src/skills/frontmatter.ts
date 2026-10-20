export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/** Разбор `---`-заголовка SKILL.md. Поддерживаются строки `ключ: значение`, кавычки и блоки `>` / `|`. */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  const lines = m[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const folded = value.startsWith('>');
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1] === '')) parts.push(lines[++i]!.trim());
      value = folded ? parts.join(' ').trim() : parts.join('\n').trim();
    } else if (value === '') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body: src.slice(m[0].length) };
}
