#!/usr/bin/env bash
# Подготовка Mac к замерам M0. Ничего не удаляет; ставит только llama.cpp и ffmpeg через Homebrew.
set -euo pipefail

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo "Нужен Mac на Apple Silicon"; exit 1; }
command -v brew >/dev/null || { echo "Нужен Homebrew: https://brew.sh"; exit 1; }
command -v node >/dev/null || { echo "Нужен Node.js >= 20"; exit 1; }

for pkg in llama.cpp ffmpeg; do
  brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg"
done

echo "--- версии"
llama-server --version 2>&1 | tail -1
ffmpeg -version | head -1
node -v

echo "--- условия замера (влияют на цифры)"
pmset -g batt | head -1
pmset -g | grep -i lowpowermode || true
echo "Подключите зарядку, выключите режим низкого энергопотребления, закройте браузер и тяжёлые приложения."
