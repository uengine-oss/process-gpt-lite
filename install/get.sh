#!/usr/bin/env bash
# Process GPT Lite one-line installer:
#   curl -fsSL https://raw.githubusercontent.com/uengine-oss/process-gpt-lite/main/install/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/uengine-oss/process-gpt-lite/main/install/get.sh | bash -s -- --profile full
# Clones the repository (shallow) and runs install/install.sh. Environment overrides:
#   PGPT_LITE_DIR (default ~/process-gpt-lite), PGPT_LITE_REPO, PGPT_LITE_REF (default main)
set -euo pipefail
REPO="${PGPT_LITE_REPO:-https://github.com/uengine-oss/process-gpt-lite.git}"
REF="${PGPT_LITE_REF:-main}"
DIR="${PGPT_LITE_DIR:-$HOME/process-gpt-lite}"
for c in git docker curl openssl; do
  command -v "$c" >/dev/null || { echo "[오류] $c 가 필요합니다." >&2; exit 1; }
done
if [ -d "$DIR/.git" ]; then
  echo "==> 기존 설치를 업데이트합니다: $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "==> 내려받습니다: $REPO ($REF) → $DIR"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
cd "$DIR/install"
# piped through bash, stdin is this script: ask questions on the terminal when there is one
if [ -r /dev/tty ] && [ -t 1 ]; then exec ./install.sh "$@" </dev/tty; else exec ./install.sh "$@"; fi
