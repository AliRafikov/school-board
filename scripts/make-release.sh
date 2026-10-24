#!/usr/bin/env bash
# Собирает архив для отправки на сервер (без данных, пользователей и паролей разработки).
#   bash scripts/make-release.sh [куда]   → school-board-ВЕРСИЯ.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
VER="$(node -p "require('./package.json').version")"
OUT="${1:-.}/school-board-$VER.tar.gz"
tar -czf "$OUT" \
  --exclude=./data --exclude=./node_modules --exclude=./backups --exclude=./.git --exclude='*.tar.gz' \
  --transform 's|^\./||' .
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
