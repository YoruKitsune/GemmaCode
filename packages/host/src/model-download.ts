import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Файл модели в репозитории Hugging Face. Версия закреплена коммитом, поэтому размер и SHA-256 известны заранее. */
export interface ModelFileSpec {
  name: string;
  role: 'model' | 'mmproj';
  size: number;
  sha256: string;
}

export interface ModelSpec {
  id: string;
  title: string;
  repo: string;
  /** Коммит репозитория: по нему адрес файла неизменен. */
  revision: string;
  license: string;
  files: ModelFileSpec[];
}

/** Gemma 4 E2B, Q4_K_M (выбор M0) и проектор мультимодальности. Хеши сверены с листингом Hugging Face и локальными файлами. */
export const DEFAULT_MODEL: ModelSpec = {
  id: 'gemma-4-e2b-q4km',
  title: 'Gemma 4 E2B (Q4_K_M)',
  repo: 'unsloth/gemma-4-E2B-it-GGUF',
  revision: '0314792d7f1f7e229411f620751375812bb9faf2',
  license: 'Apache-2.0',
  files: [
    { name: 'gemma-4-E2B-it-Q4_K_M.gguf', role: 'model', size: 3106738272, sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8' },
    { name: 'mmproj-F16.gguf', role: 'mmproj', size: 985654080, sha256: '140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa' },
  ],
};

export type FileState = 'missing' | 'partial' | 'ready';

export interface FileStatus {
  name: string;
  role: 'model' | 'mmproj';
  state: FileState;
  bytes: number;
  size: number;
}

export interface Progress {
  file: string;
  phase: 'downloading' | 'verifying' | 'done';
  received: number;
  total: number;
  bytesPerSec: number;
  /** Номер попытки после обрыва связи (0 — первая). */
  attempt: number;
}

export interface DownloaderOptions {
  dir: string;
  spec?: ModelSpec;
  /** Корень Hugging Face; для зеркал и тестов. По умолчанию HF_ENDPOINT или https://huggingface.co. */
  endpoint?: string;
  onProgress?: (p: Progress) => void;
  /** Сколько раз повторять после обрыва; каждая попытка продолжает с места обрыва. */
  maxAttempts?: number;
  /** Пауза перед первым повтором, мс (дальше удваивается до 30 с). */
  retryDelayMs?: number;
  /** Если за это время не пришло ни байта, соединение считается оборванным. */
  stallMs?: number;
  /** Запас свободного места сверх размера файлов, байт. */
  spareBytes?: number;
}

export class DownloadError extends Error {
  readonly code: 'disk' | 'hash' | 'http' | 'network' | 'conflict' | 'aborted';

  constructor(message: string, code: DownloadError['code']) {
    super(message);
    this.code = code;
  }
}

interface Marker {
  size: number;
  sha256: string;
}

/**
 * Докачка модели с Hugging Face: `*.part` в каталоге моделей, продолжение через `Range`, проверка SHA-256, затем переименование.
 * Готовый файл с меткой `*.ok` не проверяется заново и сети не требует: после первой загрузки приложение работает офлайн.
 */
export class ModelDownloader {
  private readonly o: Required<Omit<DownloaderOptions, 'onProgress'>> & Pick<DownloaderOptions, 'onProgress'>;

  constructor(opts: DownloaderOptions) {
    this.o = {
      spec: DEFAULT_MODEL,
      endpoint: (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, ''),
      maxAttempts: 8,
      retryDelayMs: 1000,
      stallMs: 30_000,
      spareBytes: 512 * 2 ** 20,
      ...opts,
    };
    this.o.endpoint = this.o.endpoint.replace(/\/$/, '');
  }

  get dir(): string {
    return this.o.dir;
  }

  get spec(): ModelSpec {
    return this.o.spec;
  }

  path(name: string): string {
    return join(this.o.dir, name);
  }

  urlOf(f: ModelFileSpec): string {
    return `${this.o.endpoint}/${this.o.spec.repo}/resolve/${this.o.spec.revision}/${f.name}`;
  }

  status(): FileStatus[] {
    return this.o.spec.files.map((f) => {
      const final = this.path(f.name);
      if (this.isVerified(f)) return { name: f.name, role: f.role, state: 'ready', bytes: f.size, size: f.size };
      const part = existsSync(`${final}.part`) ? statSync(`${final}.part`).size : 0;
      return { name: f.name, role: f.role, state: part > 0 ? 'partial' : 'missing', bytes: part, size: f.size };
    });
  }

  /** Файл на месте, размер совпал и есть метка успешной проверки хеша. */
  private isVerified(f: ModelFileSpec): boolean {
    const final = this.path(f.name);
    try {
      if (statSync(final).size !== f.size) return false;
      const m = JSON.parse(readFileSync(`${final}.ok`, 'utf8')) as Marker;
      return m.size === f.size && m.sha256 === f.sha256;
    } catch {
      return false;
    }
  }

  /** Скачивает недостающее. Прерывание сигналом оставляет `*.part` для продолжения. */
  async download(roles: ('model' | 'mmproj')[], signal?: AbortSignal): Promise<Record<'model' | 'mmproj', string | undefined>> {
    mkdirSync(this.o.dir, { recursive: true });
    const wanted = this.o.spec.files.filter((f) => roles.includes(f.role));
    this.checkDisk(wanted);
    for (const f of wanted) await this.ensureFile(f, signal);
    const pick = (role: 'model' | 'mmproj') => {
      const f = wanted.find((x) => x.role === role);
      return f ? this.path(f.name) : undefined;
    };
    return { model: pick('model'), mmproj: pick('mmproj') };
  }

  private checkDisk(files: ModelFileSpec[]): void {
    let need = this.o.spareBytes;
    for (const f of files) {
      if (this.isVerified(f)) continue;
      const part = existsSync(`${this.path(f.name)}.part`) ? statSync(`${this.path(f.name)}.part`).size : 0;
      need += f.size - part;
    }
    let free: number;
    try {
      const s = statfsSync(this.o.dir);
      free = s.bavail * s.bsize;
    } catch {
      return; // не смогли узнать: пусть решает запись
    }
    if (free < need) {
      throw new DownloadError(`Не хватает места: нужно около ${(need / 2 ** 30).toFixed(1)} ГБ, свободно ${(free / 2 ** 30).toFixed(1)} ГБ (${this.o.dir}).`, 'disk');
    }
  }

  private async ensureFile(f: ModelFileSpec, signal?: AbortSignal): Promise<void> {
    const final = this.path(f.name);
    if (this.isVerified(f)) return;
    if (existsSync(final)) {
      // файл с таким именем уже лежит (скачан вручную): принимаем, только если хеш наш
      this.emit({ file: f.name, phase: 'verifying', received: f.size, total: f.size, bytesPerSec: 0, attempt: 0 });
      const h = await hashFile(final, signal);
      if (h !== f.sha256) throw new DownloadError(`Файл ${final} уже существует, но это другая версия (SHA-256 не совпал). Переименуйте или удалите его и повторите.`, 'conflict');
      this.markVerified(f);
      this.emit({ file: f.name, phase: 'done', received: f.size, total: f.size, bytesPerSec: 0, attempt: 0 });
      return;
    }
    const part = `${final}.part`;
    let delay = this.o.retryDelayMs;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new DownloadError('Загрузка остановлена', 'aborted');
      try {
        await this.fetchInto(f, part, attempt, signal);
        break;
      } catch (e) {
        if (e instanceof DownloadError && e.code !== 'network') throw e;
        if (signal?.aborted) throw new DownloadError('Загрузка остановлена', 'aborted');
        if (attempt + 1 >= this.o.maxAttempts) throw new DownloadError(`Связь прервалась ${attempt + 1} раз подряд: ${(e as Error).message}. Загруженное сохранено, повторите позже: загрузка продолжится с места обрыва.`, 'network');
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
    this.emit({ file: f.name, phase: 'verifying', received: f.size, total: f.size, bytesPerSec: 0, attempt: 0 });
    const got = await hashFile(part, signal);
    if (got !== f.sha256) {
      unlinkSync(part);
      throw new DownloadError(`SHA-256 файла ${f.name} не совпал с ожидаемым (получено ${got.slice(0, 12)}…). Повреждённая загрузка удалена, повторите.`, 'hash');
    }
    renameSync(part, final);
    this.markVerified(f);
    this.emit({ file: f.name, phase: 'done', received: f.size, total: f.size, bytesPerSec: 0, attempt: 0 });
  }

  private markVerified(f: ModelFileSpec): void {
    writeFileSync(`${this.path(f.name)}.ok`, JSON.stringify({ size: f.size, sha256: f.sha256 } satisfies Marker));
  }

  /** Одна попытка: дописывает в `part` с позиции, на которой остановились. */
  private async fetchInto(f: ModelFileSpec, part: string, attempt: number, signal?: AbortSignal): Promise<void> {
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > f.size) {
      unlinkSync(part);
      have = 0;
    }
    if (have === f.size) return; // всё уже есть, дальше проверка хеша
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let stall: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctl.abort(new Error('нет данных больше ' + Math.round(this.o.stallMs / 1000) + ' с')), this.o.stallMs);
    };
    try {
      arm();
      let res: Response;
      try {
        res = await fetch(this.urlOf(f), { headers: have > 0 ? { range: `bytes=${have}-` } : {}, signal: ctl.signal, redirect: 'follow' });
      } catch (e) {
        throw new DownloadError(String((e as Error).cause ?? (e as Error).message), 'network');
      }
      if (res.status === 416) {
        // сервер считает, что мы просим за концом файла: начинаем заново
        unlinkSync(part);
        throw new DownloadError('сервер отклонил продолжение (416), начинаем заново', 'network');
      }
      if (res.status >= 500 || res.status === 429) throw new DownloadError(`HTTP ${res.status}`, 'network');
      if (!res.ok || !res.body) throw new DownloadError(`HTTP ${res.status} при загрузке ${f.name}${res.status === 404 ? ': файл не найден в репозитории' : ''}`, 'http');
      let append = have > 0;
      if (have > 0 && res.status !== 206) {
        // сервер проигнорировал Range и отдаёт файл с начала
        append = false;
        have = 0;
      } else if (res.status === 206) {
        const m = /bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
        if (!m || Number(m[1]) !== have) {
          unlinkSync(part);
          throw new DownloadError('сервер вернул не тот фрагмент, начинаем заново', 'network');
        }
      }
      const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
      let received = have;
      const t0 = Date.now();
      let lastEmit = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          arm();
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          received += chunk.byteLength;
          const now = Date.now();
          if (now - lastEmit >= 250) {
            lastEmit = now;
            this.emit({ file: f.name, phase: 'downloading', received, total: f.size, bytesPerSec: (received - have) / Math.max(0.001, (now - t0) / 1000), attempt });
          }
        }
      } catch (e) {
        if (signal?.aborted) throw new DownloadError('Загрузка остановлена', 'aborted');
        throw new DownloadError(String((e as Error).cause ?? (e as Error).message), 'network');
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (received < f.size) throw new DownloadError(`соединение закрылось на ${received} из ${f.size} байт`, 'network');
      if (received > f.size) {
        unlinkSync(part);
        throw new DownloadError(`файл ${f.name} длиннее ожидаемого (${received} > ${f.size}); удалён, повторите`, 'hash');
      }
    } finally {
      clearTimeout(stall);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private emit(p: Progress): void {
    this.o.onProgress?.(p);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

export function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path, { highWaterMark: 4 * 2 ** 20 });
    s.on('data', (c) => {
      h.update(c);
      if (signal?.aborted) {
        s.destroy();
        reject(new DownloadError('Загрузка остановлена', 'aborted'));
      }
    });
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}
