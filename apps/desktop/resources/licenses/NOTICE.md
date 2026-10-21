# Лицензии и уведомления GemmaCode

GemmaCode © 2026 YoruKitsune, лицензия MIT (файл `LICENSE` в репозитории). Приложение собирается из собственного кода и компонентов ниже. Лицензии компонентов, которые идут в установщик, лежат рядом с приложением (каталог `licenses` в ресурсах).

## Модель Gemma 4 (не входит в установщик)

Установщик **не содержит** модель. При первом запуске приложение по желанию пользователя скачивает файлы с Hugging Face и дальше работает без интернета:

- `gemma-4-E2B-it-Q4_K_M.gguf` и `mmproj-F16.gguf` из репозитория `unsloth/gemma-4-E2B-it-GGUF` (квантование модели `google/gemma-4-E2B-it`), версия закреплена коммитом `0314792d7f1f7e229411f620751375812bb9faf2`, целостность проверяется по SHA-256.
- Gemma 4 © Google. Лицензия: **Apache License 2.0** (карточка модели `google/gemma-4-E2B-it` на Hugging Face, `license: apache-2.0`; ссылка из карточки https://ai.google.dev/gemma/docs/gemma_4_license ведёт на страницу Apache 2.0). Полный текст: `Apache-2.0.txt` рядом с этим файлом.
- Модели по выбору в окне: `gemma-4-E4B-it-Q4_K_M.gguf` (репозиторий `unsloth/gemma-4-E4B-it-GGUF`, коммит `bfc15c382204943c3a8fff0c750b94ae2364d7a3`) и `gemma-4-12b-it-Q4_K_M.gguf` (репозиторий `unsloth/gemma-4-12B-it-GGUF`, коммит `fc034cfff751157913579611efad8462ac1be606`) с проекторами `mmproj-F16.gguf`; те же условия: Apache 2.0, проверка SHA-256.
- Квантование GGUF сделано сообществом (Unsloth); GemmaCode их файлы не изменяет.

## llama.cpp (входит в установщик)

Закреплённая сборка `b11669` (commit `620d2225c`), бинарные файлы с официального релиза https://github.com/ggml-org/llama.cpp/releases/tag/b11669. Лицензия MIT, © 2023-2026 The ggml authors; текст в `llama/<платформа>/LICENSE`.

## Electron, Chromium и их зависимости (входят в установщик)

Electron (MIT) и Chromium; полный перечень лицензий Chromium идёт в файле `LICENSES.chromium.html` рядом с исполняемым файлом приложения, лицензия Electron в файле `LICENSE`.

## Библиотеки окна и сервиса (вшиты в сборку)

React, marked, DOMPurify, pdf.js (Apache-2.0), CodeMirror, xterm.js, node-pty (`@lydell/node-pty`). В основном лицензии MIT и Apache-2.0. Точный список с версиями: `package-lock.json` в репозитории.
