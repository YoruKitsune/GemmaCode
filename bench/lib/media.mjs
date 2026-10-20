import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { sh } from './system.mjs';

// --- PNG без зависимостей: четыре цветных квадранта -------------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

export function quadrantPng(size = 224) {
  const colors = [[220, 30, 30], [30, 180, 30], [30, 60, 220], [240, 220, 30]]; // красный, зелёный, синий, жёлтый
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = colors[(y >= size / 2 ? 2 : 0) + (x >= size / 2 ? 1 : 0)];
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- Фикстуры ---------------------------------------------------------------------------

export async function makeFixtures(dir, { audioPath, videoPath } = {}) {
  mkdirSync(dir, { recursive: true });
  const out = { image: join(dir, 'quadrants.png') };
  writeFileSync(out.image, quadrantPng());

  if (audioPath) out.audio = audioPath;
  else {
    const aiff = join(dir, 'speech.aiff');
    const wav = join(dir, 'speech.wav');
    if ((await sh('say', ['-o', aiff, 'The quick brown fox jumps over the lazy dog'])) !== null && existsSync(aiff)) {
      await sh('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
      if (existsSync(wav)) out.audio = wav;
    }
  }

  if (videoPath) out.video = videoPath;
  else {
    const mp4 = join(dir, 'red-then-blue.mp4');
    await sh(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2:r=8', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2:r=8', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', mp4],
      60_000,
    );
    if (existsSync(mp4)) out.video = mp4;
  }
  return out;
}

// --- Проба ------------------------------------------------------------------------------

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

async function ask(baseUrl, part, question) {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: [part, { type: 'text', text: question }] }], temperature: 0, max_tokens: 160 }),
  });
  const body = await res.text();
  let text = '';
  let timings = null;
  try {
    const j = JSON.parse(body);
    text = j.choices?.[0]?.message?.content ?? '';
    timings = j.timings ?? null;
  } catch {
    // тело не JSON: покажем как есть
  }
  return { status: res.status, text: text || body.slice(0, 300), seconds: (performance.now() - t0) / 1000, promptTps: timings?.prompt_per_second ?? null, promptTokens: timings?.prompt_n ?? null };
}

export async function probeMedia(baseUrl, files, log = console.log) {
  const results = {};
  if (files.image) {
    const ext = files.image.split('.').pop().toLowerCase();
    const b64 = readFileSync(files.image).toString('base64');
    const r = await ask(baseUrl, { type: 'image_url', image_url: { url: `data:${MIME[ext] ?? 'image/png'};base64,${b64}` } }, 'The image is split into four quadrants. Name the color of each one: top-left, top-right, bottom-left, bottom-right.');
    const seen = ['red', 'green', 'blue', 'yellow'].filter((c) => r.text.toLowerCase().includes(c));
    results.image = { ...r, pass: r.status === 200 && seen.length === 4, note: `цвета в ответе: ${seen.join(', ') || 'нет'}` };
  }
  if (files.audio) {
    const b64 = readFileSync(files.audio).toString('base64');
    const r = await ask(baseUrl, { type: 'input_audio', input_audio: { data: b64, format: files.audio.split('.').pop() } }, 'Transcribe this audio exactly.');
    const t = r.text.toLowerCase();
    results.audio = { ...r, pass: r.status === 200 && t.includes('fox') && t.includes('dog'), note: 'ожидалась фраза про quick brown fox' };
  }
  if (files.video) {
    const b64 = readFileSync(files.video).toString('base64');
    const r = await ask(baseUrl, { type: 'input_video', input_video: { data: b64 } }, 'Which colors appear in this video, and in what order?');
    const t = r.text.toLowerCase();
    results.video = { ...r, pass: r.status === 200 && t.includes('red') && t.includes('blue') && t.indexOf('red') < t.indexOf('blue'), note: 'ожидалось: сначала красный, потом синий' };
  }
  for (const [k, v] of Object.entries(results)) log(`  ${k}: ${v.pass ? 'OK' : 'НЕТ'} (HTTP ${v.status}, ${v.seconds.toFixed(1)} с) ${v.note}\n     ответ: ${v.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  return results;
}
