import { AUDIO_CHUNK_SECONDS, AUDIO_MAX_CHUNKS, AUDIO_TOKENS_PER_SECOND, IMAGE_MAX_SIDE, IMAGE_TOKENS, type AttachmentKind } from '@gemmacode/protocol';

export interface PreparedAttachment {
  name: string;
  mime: string;
  kind: AttachmentKind;
  /** base64 каждого фрагмента. */
  parts: string[];
  note?: string;
  estTokens: number;
  preview?: string;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('Не удалось прочитать файл'));
    r.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64 = ''] = dataUrl.split(',', 2);
  const mime = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function classify(name: string, mime: string): AttachmentKind | 'video' {
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) return 'image';
  if (mime.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(name)) return 'audio';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(name)) return 'video';
  if (mime.startsWith('text/') || /\.(txt|md|json|ya?ml|toml|csv|tsv|log|xml|html?|css|scss|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|sql|ini|cfg|env|lock)$/i.test(name)) return 'text';
  return 'file';
}

/** Картинка уменьшается до IMAGE_MAX_SIDE по большей стороне: модель всё равно сожмёт её до фиксированного числа токенов, а контекст и память на 8 ГБ ценнее. */
export async function prepareImage(file: Blob, name: string): Promise<PreparedAttachment> {
  const bmp = await createImageBitmap(file);
  const srcW = bmp.width;
  const srcH = bmp.height;
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const resized = scale < 1;
  let out: Blob = file;
  let mime = file.type || 'image/png';
  if (resized || file.size > 1_500_000 || !/^image\/(png|jpeg|webp)$/.test(mime)) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // прозрачность в JPEG стала бы чёрной
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    out = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось сжать картинку'))), 'image/jpeg', 0.9));
    mime = 'image/jpeg';
    name = name.replace(/\.\w+$/, '') + '.jpg';
  }
  const preview = await blobToDataUrl(out);
  bmp.close();
  return {
    name,
    mime,
    kind: 'image',
    parts: [preview.split(',', 2)[1] ?? ''],
    note: resized ? `${srcW}×${srcH} → ${w}×${h}` : `${w}×${h}`,
    estTokens: IMAGE_TOKENS,
    preview,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Звук раскодируется браузером, сводится в моно 16 кГц и режется на фрагменты по 30 с (предел модели) в WAV. */
export async function prepareAudio(file: Blob, name: string): Promise<PreparedAttachment> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`Не удалось раскодировать звук «${name}»`);
  } finally {
    void ctx.close();
  }
  const seconds = buf.duration;
  if (seconds > AUDIO_CHUNK_SECONDS * AUDIO_MAX_CHUNKS) {
    throw new Error(`Запись ${Math.round(seconds)} с длиннее допустимых ${AUDIO_CHUNK_SECONDS * AUDIO_MAX_CHUNKS} с: обрежьте её или разбейте на части`);
  }
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i]! += ch[i]! / buf.numberOfChannels;
  }
  const chunk = AUDIO_CHUNK_SECONDS * buf.sampleRate;
  const parts: string[] = [];
  for (let start = 0; start < mono.length; start += chunk) {
    parts.push(await blobToBase64(new Blob([encodeWav(mono.subarray(start, Math.min(mono.length, start + chunk)), buf.sampleRate)], { type: 'audio/wav' })));
  }
  return {
    name: name.replace(/\.\w+$/, '') + '.wav',
    mime: 'audio/wav',
    kind: 'audio',
    parts,
    note: `${Math.round(seconds)} с${parts.length > 1 ? `, ${parts.length} фрагм.` : ''}`,
    estTokens: Math.round(seconds * AUDIO_TOKENS_PER_SECOND),
  };
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(out);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // моно
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return out;
}

export async function prepareAny(file: Blob, name: string): Promise<PreparedAttachment> {
  const kind = classify(name, file.type);
  if (kind === 'video') throw new Error('Видео не поддерживается: приложите кадры как картинки или звук отдельным файлом.');
  if (kind === 'image') return prepareImage(file, name);
  if (kind === 'audio') return prepareAudio(file, name);
  return { name, mime: file.type || 'application/octet-stream', kind, parts: [await blobToBase64(file)], estTokens: 0 };
}
