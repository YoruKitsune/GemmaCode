# Проверка M2 на Mac (MacBook Air M1 8 ГБ)

Дата: 2026-10-21. Ветка `m2` (cc6dff8) поверх ec21028, Node 26.12.0, npm 11.20.0, Electron 45.0.0, llama.cpp 0.7.0 (build 11669).

## Шаг 1. Сборка и тесты

| Проверка | Результат |
|---|---|
| `git fetch bundle m2:m2 && checkout m2` | ок, рабочее дерево было чистым |
| `npm install` | ок, но бинарник Electron **не скачался** (npm: «install-scripts not yet covered by allowScripts»). Вручную `node node_modules/electron/install.js` — скачал без ошибок |
| `npm run typecheck` (apps/desktop), а также core, protocol, host | чисто |
| core | **74 pass / 0 fail** (в задаче ожидалось 70; Seatbelt-тесты прошли: 4 из 4) |
| protocol | **6 pass / 0 fail** |
| host | **12 pass / 1 fail** → после исправления **13 / 0** (см. ниже) |
| `npm run build` (apps/desktop) | ок (host.cjs 852 КБ, tsc main, vite renderer) |
| `require('@lydell/node-pty')` в packages/host | ок (`spawn, fork, createTerminal, open`) |
| `scripts/electron-smoke.ts` на Mac (бонус) | 8 из 8: окно, IPC, ход агента, diff, терминал (node-pty в utility-процессе), нет ошибок консоли, самозавершение |

### Найденная ошибка: дубли моделей на регистронезависимой ФС
- Файл: `packages/host/src/config-store.ts`, `scanModels` / `MODEL_ROOTS`.
- Симптом: тест `host.test.ts:262` («настройки … модели находятся и получают mmproj») падает: `2 !== 1`.
- Причина: на APFS `~/models` и `~/Models` — один каталог, и обход идёт дважды, отдавая один GGUF с двумя разными путями (разный регистр). Пользователю в настройках показало бы две одинаковые модели.
- Исправление: коммит `8f48c2e` на ветке **`m2-mac-fixes`** (обход каждого реального пути один раз через `realpathSync.native`). После него host: 13/13, typecheck чисто. В `m2` и `main` исправление вошло коммитом `b4c7569` (cherry-pick `8f48c2e`).

## Шаг 2. Модель и mmproj

- Q4_K_M (уже была): `~/.cache/huggingface/hub/models--unsloth--gemma-4-E2B-it-GGUF/snapshots/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf` (3 106 738 272 Б). Именно Q4_K_M: в снапшоте нет других файлов с таким именем, а в `/props` сервера путь заканчивается на `...Q4_K_M.gguf`.
- mmproj не было. Скачал `mmproj-F16.gguf` (985 654 080 Б, размер совпал с HF API) из того же репозитория `unsloth/gemma-4-E2B-it-GGUF` в тот же каталог снапшота: `.../snapshots/0314792d.../mmproj-F16.gguf`. Сканер моделей приложения находит пару сам (mmproj в одном каталоге с моделью).
- `llama-server`: `/opt/homebrew/bin/llama-server`. `/props` сообщает `modalities: {vision: true, video: true, audio: true}`. В логе одно предупреждение: `init_audio: audio input is in experimental stage and may have reduced quality`.

## Шаг 3. Картинка и звук напрямую (llama-server, порт 8091)

Флаги как в `args.ts`/`factory.ts`: `-c 16384 -np 1 -fa on -ctk q8_0 -ctv q8_0 --jinja --reasoning off --no-webui --mmproj …`.
Материалы: `assets/pic-1024.jpg` (1600×800 → 1024×512, красный круг на синем фоне, «GEMMA 42»), `assets/phrase.wav` (16 кГц моно, 5,1 с: «The quick brown fox jumps over the lazy dog. My number is forty two.»). Скрипт: `scripts/probe.mjs`; сырые ответы: `step3-*.json`.

| Проба | Принято? | Ответ модели (дословно) | TTFT | Декод | Промпт |
|---|---|---|---|---|---|
| image_url (data:image/jpeg;base64), вопрос по-русски | да | «На картинке изображен **синий фон** с **большим красным кругом** слева и **белым текстом** справа. … Текст состоит из двух строк: 1. **GEMMA** 2. **42**» | 2,66 с (260 токенов, 102 ток/с префилл) | 18,9 ток/с | 260 ток |
| input_audio (wav), вопрос по-русски | да | «Заквик Браун Фокс джампс овер зе лези дог. Май намбер из 42.» | 1,25 с | 20,9 ток/с | 151 ток |
| input_audio, вопрос по-английски | да | «Zack Brown Fox jumps over the lazy dog. My number is 42.» | 0,92 с | 20,4 ток/с | — |
| только текст | — | — | 0,24 с | 20,4 ток/с | — |

- Картинка описана **верно** (круг, цвет, фон, текст).
- Звук **распознан в целом верно**, `input_audio` с `format: "wav"` принимается без ошибок. Но «The quick» теряется/искажается («Zack», «Заквик»), т. е. качество не идеальное, что согласуется с предупреждением «experimental». Число «forty two» → «42».
- RSS llama-server: **≈2,4 ГБ** (2406 → 2412 МБ после проб; 2385 в конце).
- Скорость 19–21 ток/с совпадает с M0/M1 (20–22). Цель 60 ток/с чистым декодом по-прежнему не достигается.

## Шаг 4. Настоящее приложение с настоящей моделью

Скрипт `scripts/real-app.mjs`, журнал `real-app-journal.log`, итог `real-app-results.json`, скриншоты `screens/01…10`. `HOME=~/Projects/m2-results/run/home`, проект `run/project` (git, utils.js с `a - b`, README.md), режим «ask», CDP-порт 9333.

| # | Шаг | Результат |
|---|---|---|
| 1 | окно открылось; индикатор модели зелёный | окно за ~0,9 с; индикатор зелёный через **6,3 с** от запуска Electron (llama-server стартовал за ≈5,3 с, модель в кэше ОС), `01-window`, `02-model-ready` |
| 2 | «Исправь функцию sum в utils.js: она должна складывать» | **см. ниже: с точной фразой модель карточку не вызвала**. После уточнения («Сначала прочитай utils.js инструментом read_file, потом исправь…») появилась карточка «Нужно подтверждение» с корректным diff (`- return a - b;` / `+ return a + b;`), файл до нажатия не менялся, «Разрешить» → `utils.js` стал `return a + b;`. Итоговый ответ: «Я исправил функцию sum в utils.js, чтобы она складывала числа (a + b).» (`03`, `04`) |
| 3 | PNG через `input[type=file]`, «Что нарисовано на картинке?» | чип «1600×800 → 1024×512 ≈ 280 токенов контекста». Ответ: «На картинке изображен логотип или баннер с надписью "GEMMA 42" на синем фоне. В центре находится большой красный круг.» — **верно** (`05`, `06`). В первом прогоне: «…логотип или брендинг, связанный с моделью GEMMA 42. Красный круг… Текст "GEMMA 42". Фон синего цвета.» |
| 4 | WAV, «Что сказано в записи?» | чип «phrase.wav 5 с ≈ 128 токенов». Ответ: «В записи сказано: "Zack Quick Brown Fox jumps over the lazy dog. My number is forty-two."» — **почти верно** («The» → «Zack») (`07`, `08`) |
| 5 | откат к первому сообщению | диалог «Откатить изменения?», подтверждение; `utils.js` совпал с исходным побайтно, лента пуста (0 сообщений пользователя) (`09`, `10`) |

- **Скорость в строке статуса: 19,4–24,3 ток/с** (последние значения 23,0–24,3).
- **Память (RSS, МБ)**: llama-server 2421–2467; Electron всего 202–296 (main 45–67, utility-процесс host + прочие helper’ы 81–137, renderer 66–96). Итого около **2,7 ГБ** на всё приложение.
- Консоль окна: ошибок нет. Электрон завершился сам с кодом 0 по SIGTERM; `pgrep llama-server` после закрытия пуст (до закрытия был один процесс), Electron тоже не остался.
- Сообщения вида «Электрон завершился» и стек в stderr отсутствуют; в `electron-stderr.log` только строка `DevTools listening`.

### Поведение модели (не ошибка Mac-сборки)
На дословную фразу из задания в обоих прогонах (детерминированно, ход идентичный) Gemma 4 E2B вызвала не `read_file`, а ответила текстом: «Please provide the content of utils.js so I can fix the sum function for you. If you don't have the content, I can try to read it if it exists.» — то есть не использовала инструменты и ответила по-английски на русский запрос. С явной подсказкой про `read_file` цепочка read_file → edit_file работает. Для M3 это повод усилить системный промпт («файлов не видишь — прочитай сам инструментом, не проси пользователя») либо добавить проверку «нет tool call на просьбу правки → повторный запрос». Первый (неудачный по этой причине) прогон сохранён в `run1-failed-first-attempt/`; в нём же шаг 5 «упал» только из-за моего ожидания текста заметки: при отсутствии правок приложение пишет «Откат к ходу «…»: файлы не менялись.» (`host.ts:477`), а не «Откат: файлы возвращены…» — это штатно.

## Что не проверялось
- Видео (сервер сообщает `video: true`), аудио длиннее ~5 с, большие картинки через пикер.
- `npm run test:e2e` (там жёстко прошит путь Linux-Chromium `/opt/pw-browsers/...`; на Mac нужен `CHROME_PATH`) — вместо него прогнан `test:smoke` и свой сценарий через CDP к настоящему Electron.
- Упаковка (electron-builder/подпись) — вне задачи.

## Мелочи
- `npm install` печатает «install-scripts not yet covered by allowScripts» для esbuild/fsevents и не запускает postinstall у Electron — на чистой машине бинарник Electron придётся доставлять вручную (`node node_modules/electron/install.js`) или описать в README / `allowScripts` в package.json.
- node предупреждает `MODULE_TYPELESS_PACKAGE_JSON` для `apps/desktop/scripts/*.ts` (нет `"type": "module"` в apps/desktop/package.json) — безвредно.
