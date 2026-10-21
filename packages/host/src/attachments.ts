import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ContentPart, UserMessageUi } from '@gemmacode/core';
import type { AttachmentKind, AttachmentRef } from '@gemmacode/protocol';
import { IMAGE_TOKENS } from '@gemmacode/protocol';
import { looksBinary, mediaKind, toPosix } from './files.ts';

const INLINE_TEXT_CHARS = 6000;
const MAX_ATTACH_BYTES = 40_000_000;

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
};

function safeName(name: string): string {
  const base = basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return base || 'file';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

export const estimateTextTokens = (chars: number): number => Math.ceil(chars / 3.6);

/** Сохраняет вложение внутри проекта (`.gemmacode/attachments/`), чтобы агент мог вернуться к нему в следующих ходах. */
export function saveAttachment(
  root: string,
  a: { name: string; mime: string; kind: AttachmentKind; parts: string[]; note?: string; estTokens?: number },
): AttachmentRef {
  if (!a.parts.length) throw new Error('Пустое вложение');
  const id = stamp();
  const dir = join(root, '.gemmacode', 'attachments', id);
  mkdirSync(dir, { recursive: true });
  const name = safeName(a.name);
  const ext = extname(name).slice(1).toLowerCase() || MIME_EXT[a.mime] || '';
  const stem = extname(name) ? name.slice(0, -extname(name).length) : name;
  const relPaths: string[] = [];
  let size = 0;
  a.parts.forEach((b64, i) => {
    const buf = Buffer.from(b64, 'base64');
    size += buf.length;
    if (size > MAX_ATTACH_BYTES) throw new Error('Вложение слишком большое');
    const file = a.parts.length === 1 ? (ext ? `${stem}.${ext}` : stem) : `${stem}-part${i + 1}.${ext || 'bin'}`;
    writeFileSync(join(dir, file), buf);
    relPaths.push(toPosix(join('.gemmacode', 'attachments', id, file)));
  });
  let kind = a.kind;
  let est = a.estTokens;
  if (est === undefined) {
    if (kind === 'image') est = IMAGE_TOKENS;
    else if (kind === 'text') est = estimateTextTokens(size);
    else est = 0;
  }
  return { id, name, kind, relPaths, size, estTokens: est, ...(a.note ? { note: a.note } : {}) };
}

/** Вложение — файл самого проекта: копировать не нужно, ссылаемся на путь. Картинки и звук сюда не попадают (их готовит окно). */
export function attachmentFromProjectFile(root: string, rel: string): AttachmentRef {
  const abs = join(root, rel);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`${rel} — не файл`);
  if (mediaKind(abs)) throw new Error('Картинки и звук подготавливает окно: они уменьшаются и режутся на фрагменты');
  const buf = readFileSync(abs);
  const text = !looksBinary(buf);
  return {
    id: stamp(),
    name: basename(rel),
    kind: text ? 'text' : 'file',
    relPaths: [toPosix(rel)],
    size: st.size,
    estTokens: text ? estimateTextTokens(Math.min(st.size, INLINE_TEXT_CHARS)) : 0,
  };
}

export interface BuiltContent {
  content: string | ContentPart[];
  ui: UserMessageUi;
  /** Есть картинки или звук: нужен проектор мультимодальности. */
  hasMedia: boolean;
}

/** Собирает сообщение для модели: текст пользователя, вставки из текстовых файлов и медиа-части. */
export function buildUserContent(root: string, text: string, attachments: AttachmentRef[]): BuiltContent {
  const ui: UserMessageUi = {
    text,
    attachments: attachments.map((a) => ({ name: a.name, kind: a.kind, relPaths: a.relPaths, ...(a.note ? { note: a.note } : {}) })),
  };
  if (!attachments.length) return { content: text, ui, hasMedia: false };

  let body = text;
  const media: ContentPart[] = [];
  for (const a of attachments) {
    const paths = a.relPaths.map((r) => join(root, r));
    if (a.kind === 'image') {
      body += `\n\n[Attached image: ${a.name}]`;
      media.push({ type: 'image', path: paths[0]! });
    } else if (a.kind === 'audio') {
      paths.forEach((p, i) => {
        body += `\n\n[Attached audio: ${a.name}${paths.length > 1 ? `, part ${i + 1} of ${paths.length}` : ''}]`;
        media.push({ type: 'audio', path: p });
      });
    } else if (a.kind === 'text') {
      const full = readFileSync(paths[0]!, 'utf8');
      if (full.length <= INLINE_TEXT_CHARS) body += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${full}\n\`\`\``;
      else {
        const lines = full.split('\n').length - (full.endsWith('\n') ? 1 : 0);
        body += `\n\n[Attached file: ${a.name}, ${lines} lines, too long to paste here. Read it with read_file path="${a.relPaths[0]}". Beginning:]\n\`\`\`\n${full.slice(0, 1500)}\n\`\`\``;
      }
    } else {
      body += `\n\n[Attached file: ${a.name}, saved at ${a.relPaths[0]}. It is binary and cannot be read as text.]`;
    }
  }
  const parts: ContentPart[] = [{ type: 'text', text: body }, ...media];
  return { content: media.length ? parts : body, ui, hasMedia: media.length > 0 };
}
