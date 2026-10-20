export type Suite = 'edit30' | 'gen20';
export type Category = 'fix' | 'edit' | 'refactor' | 'feature' | 'gen';

export interface EvalTask {
  id: string;
  suite: Suite;
  category: Category;
  /** Запрос пользователя к агенту. */
  prompt: string;
  /** Начальное состояние проекта. */
  files: Record<string, string>;
  /** Тесты проверки: перезаписываются перед проверкой, чтобы агент не мог «починить» тест. Если showTests, лежат в проекте с начала. */
  tests: Record<string, string>;
  showTests?: boolean;
  /** Команда проверки; по умолчанию `node --test`. */
  verify?: string;
  /** Эталонное решение: файлы после правильной правки (null — файл удалён). Нужно для самопроверки набора. */
  solution: Record<string, string | null>;
}

export const PKG = { 'package.json': '{\n  "name": "task",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' };
