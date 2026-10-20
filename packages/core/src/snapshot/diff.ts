/** Построчный unified diff (LCS) для показа правок и для само-ревью. Большие файлы сравниваются грубо. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);
  const ops = diffLines(a, b);
  const header = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  const hunks = toHunks(ops, context);
  if (hunks.length === 0) return '';
  return [...header, ...hunks].join('\n');
}

function splitLines(s: string): string[] {
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { t: ' ' | '-' | '+'; line: string };

function diffLines(a: string[], b: string[]): Op[] {
  // Общие начало и конец отбрасываем, остаток сравниваем LCS.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const mid: Op[] = [];
  const am = a.slice(s, ea);
  const bm = b.slice(s, eb);
  if (am.length * bm.length > 4_000_000) {
    for (const l of am) mid.push({ t: '-', line: l });
    for (const l of bm) mid.push({ t: '+', line: l });
  } else {
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        mid.push({ t: ' ', line: am[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) mid.push({ t: '-', line: am[i++]! });
      else mid.push({ t: '+', line: bm[j++]! });
    }
    while (i < n) mid.push({ t: '-', line: am[i++]! });
    while (j < m) mid.push({ t: '+', line: bm[j++]! });
  }
  return [...a.slice(0, s).map((line): Op => ({ t: ' ', line })), ...mid, ...a.slice(ea).map((line): Op => ({ t: ' ', line }))];
}

function toHunks(ops: Op[], context: number): string[] {
  const changed: number[] = [];
  ops.forEach((o, i) => o.t !== ' ' && changed.push(i));
  if (!changed.length) return [];
  const hunks: string[] = [];
  let k = 0;
  while (k < changed.length) {
    let from = Math.max(0, changed[k]! - context);
    let to = Math.min(ops.length, changed[k]! + context + 1);
    while (k + 1 < changed.length && changed[k + 1]! - context <= to) {
      k++;
      to = Math.min(ops.length, changed[k]! + context + 1);
    }
    k++;
    from = Math.max(0, from);
    let oldStart = 1;
    let newStart = 1;
    for (let i = 0; i < from; i++) {
      if (ops[i]!.t !== '+') oldStart++;
      if (ops[i]!.t !== '-') newStart++;
    }
    const slice = ops.slice(from, to);
    const oldLen = slice.filter((o) => o.t !== '+').length;
    const newLen = slice.filter((o) => o.t !== '-').length;
    hunks.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...slice.map((o) => `${o.t}${o.line}`));
  }
  return hunks;
}
