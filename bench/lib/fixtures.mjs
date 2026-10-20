/** Детерминированные тексты для замеров: без случайности, чтобы запуски были сравнимы. */

const ENTITIES = ['order', 'invoice', 'customer', 'shipment', 'refund', 'coupon', 'ticket', 'session'];

/** Исходник на TypeScript примерно на 120 строк: типичная «правка файла» для агента. */
export function sampleSource() {
  const parts = ["import { db } from './db';", "import { logger } from './logger';", ''];
  for (const e of ENTITIES) {
    const E = e[0].toUpperCase() + e.slice(1);
    parts.push(
      `export interface ${E} {`,
      '  id: string;',
      '  createdAt: Date;',
      `  status: 'new' | 'active' | 'closed';`,
      '}',
      '',
      `export async function load${E}(id: string): Promise<${E} | undefined> {`,
      `  const row = await db.get('${e}s', id);`,
      `  if (!row) {`,
      `    logger.warn('${e} not found', { id });`,
      '    return undefined;',
      '  }',
      `  return { id: row.id, createdAt: new Date(row.created_at), status: row.status };`,
      '}',
      '',
      `export async function close${E}(id: string): Promise<void> {`,
      `  const item = await load${E}(id);`,
      `  if (!item || item.status === 'closed') return;`,
      `  await db.update('${e}s', id, { status: 'closed' });`,
      `  logger.info('${e} closed', { id });`,
      '}',
      '',
    );
  }
  return parts.join('\n');
}

/** Текст ~tokens токенов (грубо 3,6 символа на токен для кода), каждый блок уникален. */
export function filler(tokens) {
  const chars = Math.round(tokens * 3.6);
  const out = [];
  let n = 0;
  let len = 0;
  while (len < chars) {
    const block = `function step${n}(input${n}: number): number {\n  const scaled${n} = input${n} * ${n + 3};\n  return scaled${n} % ${n + 97};\n}\n`;
    out.push(block);
    len += block.length;
    n++;
  }
  return out.join('\n');
}

export const SCENARIOS = {
  chat: {
    title: 'Декод: свободный ответ (чистая скорость генерации)',
    messages: () => [
      { role: 'user', content: 'Explain step by step how a hash map handles collisions, with examples in TypeScript. Be thorough.' },
    ],
    maxTokens: 256,
    minPredicted: 128,
  },
  prefill2k: {
    title: 'Префилл ~2K токенов',
    messages: () => [{ role: 'user', content: `${filler(2000)}\n\nReply with one short sentence: what do these functions do?` }],
    maxTokens: 24,
  },
  prefill8k: {
    title: 'Префилл ~8K токенов',
    messages: () => [{ role: 'user', content: `${filler(8000)}\n\nReply with one short sentence: what do these functions do?` }],
    maxTokens: 24,
  },
  edit: {
    title: 'Правка файла (переписывание куска контекста: лучший случай для prompt lookup)',
    messages: () => [
      {
        role: 'user',
        content: `Here is a file:\n\n\`\`\`ts\n${sampleSource()}\n\`\`\`\n\nRename the function closeOrder to finishOrder everywhere. Output the complete updated file in a single code block and nothing else.`,
      },
    ],
    maxTokens: 1500,
    minPredicted: 400,
  },
};
