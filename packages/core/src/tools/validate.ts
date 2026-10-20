import type { JsonSchemaObject, JsonSchemaProp } from './types.ts';

export type Validated =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Проверка аргументов вызова по схеме инструмента. Маленькая модель часто путает типы (число строкой,
 * массив одной строкой), поэтому очевидные случаи приводятся, а остальное превращается в понятную ошибку,
 * которая возвращается модели для повторной попытки.
 */
export function validateArgs(schema: JsonSchemaObject, raw: string | Record<string, unknown>, toolName: string): Validated {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') value = {};
    else {
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, error: `Invalid arguments for ${toolName}: not valid JSON. ${expected(schema)}` };
      }
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `Invalid arguments for ${toolName}: expected a JSON object. ${expected(schema)}` };
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const key of Object.keys(input)) {
    if (!(key in schema.properties)) {
      if (schema.additionalProperties === false || schema.additionalProperties === undefined) problems.push(`unknown argument "${key}"`);
    }
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    const c = coerce(v, prop);
    if (c.ok) out[key] = c.value;
    else problems.push(`argument "${key}": ${c.error}`);
  }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined && !problems.some((p) => p.startsWith(`argument "${key}"`))) problems.push(`missing required argument "${key}"`);
  }
  if (problems.length) return { ok: false, error: `Invalid arguments for ${toolName}: ${problems.join('; ')}. ${expected(schema)}` };
  return { ok: true, args: out };
}

function expected(schema: JsonSchemaObject): string {
  const parts = Object.entries(schema.properties).map(([k, p]) => `${k}${schema.required?.includes(k) ? '' : '?'}: ${p.type}`);
  return `Expected {${parts.join(', ')}}.`;
}

type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

function coerce(v: unknown, prop: JsonSchemaProp): Coerced {
  switch (prop.type) {
    case 'string':
      if (typeof v === 'string') return enumCheck(v, prop);
      if (typeof v === 'number' || typeof v === 'boolean') return enumCheck(String(v), prop);
      return { ok: false, error: 'expected a string' };
    case 'number':
    case 'integer': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, error: `expected a ${prop.type}` };
      if (prop.type === 'integer' && !Number.isInteger(n)) return { ok: false, error: 'expected an integer' };
      return { ok: true, value: n };
    }
    case 'boolean':
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (v === 'true') return { ok: true, value: true };
      if (v === 'false') return { ok: true, value: false };
      return { ok: false, error: 'expected true or false' };
    case 'array': {
      let arr: unknown = v;
      if (typeof v === 'string') {
        try {
          arr = JSON.parse(v);
        } catch {
          arr = v.split('\n').map((s) => s.trim()).filter(Boolean);
        }
      }
      if (!Array.isArray(arr)) return { ok: false, error: 'expected an array' };
      return { ok: true, value: arr };
    }
    case 'object':
      if (typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
      return { ok: false, error: 'expected an object' };
  }
}

function enumCheck(s: string, prop: JsonSchemaProp): Coerced {
  if (prop.enum && !prop.enum.includes(s)) return { ok: false, error: `must be one of ${prop.enum.join(', ')}` };
  return { ok: true, value: s };
}
