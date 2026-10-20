import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

interface Entry {
  /** Файл существовал до правки; если да, оригинал лежит в `blob`. */
  existed: boolean;
  blob?: string;
}

export interface Checkpoint {
  id: number;
  label: string;
  createdAt: string;
  files: Record<string, Entry>;
}

/**
 * Снимки для отката сессии: перед первой правкой файла в рамках контрольной точки (обычно один ход пользователя)
 * копия оригинала уходит в `.gemmacode/snapshots/<сессия>/`. Откат возвращает файлы к состоянию до выбранного хода.
 * Охватывает файловые инструменты; побочные эффекты shell-команд снимок не видит.
 */
export class SnapshotStore {
  private readonly dir: string;
  private readonly root: string;
  private checkpoints: Checkpoint[] = [];

  constructor(projectRoot: string, sessionId: string) {
    this.root = projectRoot;
    this.dir = join(projectRoot, '.gemmacode', 'snapshots', sessionId);
    this.load();
  }

  private manifestPath(id: number): string {
    return join(this.dir, `cp-${String(id).padStart(4, '0')}`, 'manifest.json');
  }

  private load(): void {
    for (let id = 1; existsSync(this.manifestPath(id)); id++) {
      this.checkpoints.push(JSON.parse(readFileSync(this.manifestPath(id), 'utf8')) as Checkpoint);
    }
  }

  private save(cp: Checkpoint): void {
    mkdirSync(dirname(this.manifestPath(cp.id)), { recursive: true });
    writeFileSync(this.manifestPath(cp.id), JSON.stringify(cp, null, 1));
  }

  /** Начинает новую контрольную точку (вызывается в начале хода пользователя). */
  begin(label: string): Checkpoint {
    const cp: Checkpoint = { id: this.checkpoints.length + 1, label, createdAt: new Date().toISOString(), files: {} };
    this.checkpoints.push(cp);
    this.save(cp);
    return cp;
  }

  list(): readonly Checkpoint[] {
    return this.checkpoints;
  }

  /** Сохраняет оригинал файла перед изменением (один раз на контрольную точку). */
  record(abs: string): void {
    let cp = this.checkpoints[this.checkpoints.length - 1];
    if (!cp) cp = this.begin('session');
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || cp.files[rel]) return;
    if (existsSync(abs)) {
      const blob = join(dirname(this.manifestPath(cp.id)), 'files', rel);
      mkdirSync(dirname(blob), { recursive: true });
      copyFileSync(abs, blob);
      cp.files[rel] = { existed: true, blob: relative(this.dir, blob) };
    } else {
      cp.files[rel] = { existed: false };
    }
    this.save(cp);
  }

  /** Файлы, изменённые начиная с контрольной точки `id`. */
  changedSince(id: number): string[] {
    const set = new Set<string>();
    for (const cp of this.checkpoints) if (cp.id >= id) for (const f of Object.keys(cp.files)) set.add(f);
    return [...set].sort();
  }

  /** Возвращает файлы к состоянию до контрольной точки `id` и забывает её и все более поздние. */
  rollbackTo(id: number): string[] {
    const restored = new Set<string>();
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const cp = this.checkpoints[i]!;
      if (cp.id < id) break;
      for (const [rel, e] of Object.entries(cp.files)) {
        const abs = join(this.root, rel);
        if (e.existed && e.blob) {
          mkdirSync(dirname(abs), { recursive: true });
          copyFileSync(join(this.dir, e.blob), abs);
        } else {
          rmSync(abs, { force: true });
        }
        restored.add(rel);
      }
      rmSync(dirname(this.manifestPath(cp.id)), { recursive: true, force: true });
      this.checkpoints.pop();
    }
    return [...restored].sort();
  }
}
