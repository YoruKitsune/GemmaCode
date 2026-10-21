/** Разбор unified diff (формат ядра, см. core/snapshot/diff.ts) для показа в окне и подсчёта «+N −M». */

export interface DiffLine {
  t: ' ' | '+' | '-';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/**
 * Разбирает diff одного файла или нескольких, склеенных подряд. Тело ханка читается по счётчикам из заголовка `@@`,
 * поэтому удалённая строка вида «-- комментарий» (в diff она «--- комментарий») не принимается за заголовок файла.
 */
export function parseUnifiedDiff(text: string): ParsedDiff[] {
  const out: ParsedDiff[] = [];
  let cur: ParsedDiff | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of text.split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const t = raw[0];
      const body = raw.slice(1);
      if (t === '+') {
        hunk.lines.push({ t: '+', text: body, newNo: newNo++ });
        cur!.added++;
        newLeft--;
      } else if (t === '-') {
        hunk.lines.push({ t: '-', text: body, oldNo: oldNo++ });
        cur!.removed++;
        oldLeft--;
      } else {
        // контекст; пустая строка — контекстная пустая строка, у которой потерялся ведущий пробел
        hunk.lines.push({ t: ' ', text: t === ' ' ? body : raw, oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (raw.startsWith('--- ')) {
      cur = { oldPath: raw.slice(4).replace(/^a\//, ''), newPath: '', hunks: [], added: 0, removed: 0 };
      out.push(cur);
      hunk = undefined;
      continue;
    }
    if (raw.startsWith('+++ ') && cur && cur.hunks.length === 0) {
      cur.newPath = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h && cur) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      hunk = { header: raw, lines: [] };
      cur.hunks.push(hunk);
    }
  }
  return out;
}

export function diffStats(text: string): { added: number; removed: number; files: number } {
  const files = parseUnifiedDiff(text);
  return { added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), files: files.length };
}
