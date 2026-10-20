/** Обрезка длинного вывода: начало и конец сохраняются, середина заменяется пометкой. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${cut} chars omitted ...]\n${text.slice(text.length - tail)}`;
}

/** Грубая оценка числа токенов: ~3,6 символа на токен для кода и ~2,5 для кириллицы. */
export function estimateTokens(text: string): number {
  let cyr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x400 && c <= 0x4ff) cyr++;
  }
  return Math.ceil((text.length - cyr) / 3.6 + cyr / 2.5);
}
