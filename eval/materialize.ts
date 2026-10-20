import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execCommand, type SandboxRunner } from '@gemmacode/core';
import type { EvalTask } from './types.ts';

export function writeFiles(dir: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    if (content === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Свежий каталог проекта с начальными файлами задачи (и видимыми тестами). */
export function materialize(task: EvalTask): string {
  const dir = mkdtempSync(join(tmpdir(), `gc-eval-${task.id}-`));
  writeFiles(dir, task.files);
  if (task.showTests) writeFiles(dir, task.tests);
  return dir;
}

export interface Verdict {
  passed: boolean;
  output: string;
}

/** Проверка результата: тесты задачи перезаписываются эталонными и запускается команда проверки. */
export async function verifyTask(task: EvalTask, dir: string, sandbox?: SandboxRunner): Promise<Verdict> {
  writeFiles(dir, task.tests);
  const r = await execCommand(task.verify ?? 'node --test', { cwd: dir, timeoutS: 60, maxOutputChars: 2500, ...(sandbox ? { sandbox } : {}) });
  return { passed: r.exitCode === 0 && !r.timedOut, output: r.output };
}
