import { DEFAULT_MODEL, type ModelSpec } from './model-download.ts';

/** Запись каталога: что скачиваем и сколько памяти машины нужно, чтобы модель работала без свопа. */
export interface CatalogEntry {
  spec: ModelSpec;
  /** Короткое имя для списка. */
  label: string;
  /** Объём оперативной памяти машины, с которого модель считается подходящей (оценка плана: система и окно занимают 4–5 ГБ). */
  minRamGB: number;
  note: string;
}

const GIB = 2 ** 30;

/**
 * Gemma 4 в Q4_K_M и проекторы мультимодальности (F16) из репозиториев Unsloth. Версия каждого репозитория закреплена коммитом,
 * размеры и SHA-256 взяты из листинга Hugging Face; `npm run verify:catalog` сверяет их с самим Hugging Face.
 */
export const MODEL_CATALOG: CatalogEntry[] = [
  { spec: DEFAULT_MODEL, label: 'E2B', minRamGB: 8, note: 'по умолчанию: быстрая, помещается в 8 ГБ' },
  {
    spec: {
      id: 'gemma-4-e4b-q4km',
      title: 'Gemma 4 E4B (Q4_K_M)',
      repo: 'unsloth/gemma-4-E4B-it-GGUF',
      revision: 'bfc15c382204943c3a8fff0c750b94ae2364d7a3',
      license: 'Apache-2.0',
      files: [
        { name: 'gemma-4-E4B-it-Q4_K_M.gguf', role: 'model', size: 4977171584, sha256: '85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87' },
        { name: 'mmproj-F16.gguf', role: 'mmproj', size: 990372672, sha256: 'ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51' },
      ],
    },
    label: 'E4B',
    minRamGB: 16,
    note: 'ожидаемо точнее в вызовах инструментов и коде, но медленнее E2B (на нашей машине не мерили)',
  },
  {
    spec: {
      id: 'gemma-4-12b-q4km',
      title: 'Gemma 4 12B (Q4_K_M)',
      repo: 'unsloth/gemma-4-12B-it-GGUF',
      revision: 'fc034cfff751157913579611efad8462ac1be606',
      license: 'Apache-2.0',
      files: [
        { name: 'gemma-4-12b-it-Q4_K_M.gguf', role: 'model', size: 7121861440, sha256: '0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42' },
        { name: 'mmproj-F16.gguf', role: 'mmproj', size: 175115840, sha256: '91f086971e56d7a7d8d39e271873fccdb49541bd259d6e02c401a4f1cb7a219e' },
      ],
    },
    label: '12B',
    minRamGB: 24,
    note: 'самая сильная, нужна память 24 ГБ и больше; на M1 8 ГБ не запустится',
  },
];

export type Fit = 'ok' | 'tight' | 'no';

/** Влезет ли модель: `ok` с минимального объёма, `tight` от трёх четвертей (будет своп и тормоза), иначе `no`. */
export function memoryFit(entry: CatalogEntry, totalMemGB: number): Fit {
  if (totalMemGB >= entry.minRamGB) return 'ok';
  if (totalMemGB >= entry.minRamGB * 0.75) return 'tight';
  return 'no';
}

/** Самая крупная подходящая по памяти модель. Выбором по умолчанию остаётся E2B, это только подсказка в окне. */
export function recommendedModelId(totalMemGB: number): string {
  let best = MODEL_CATALOG[0]!;
  for (const e of MODEL_CATALOG) if (memoryFit(e, totalMemGB) === 'ok' && e.minRamGB >= best.minRamGB) best = e;
  return best.spec.id;
}

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return MODEL_CATALOG.find((e) => e.spec.id === id);
}

export function totalBytes(spec: ModelSpec, role?: 'model' | 'mmproj'): number {
  return spec.files.filter((f) => !role || f.role === role).reduce((n, f) => n + f.size, 0);
}

export const bytesToGB = (n: number): number => n / GIB;
