#!/usr/bin/env bash
# Process GPT Lite installer, pinned to one release.
#
# Safe use: download the script of a release, check it against the SHA-256 on the release page, then run it.
#   curl -fsSLO https://raw.githubusercontent.com/uengine-oss/process-gpt-lite/v0.2.0/install/get.sh
#   shasum -a 256 get.sh        # must match the value on the release page
#   bash get.sh                 # or: bash get.sh --profile full
#
# It clones exactly the release tag below (shallow) and runs install/install.sh from it.
# Environment overrides: PGPT_LITE_DIR (default ~/process-gpt-lite), PGPT_LITE_REPO, PGPT_LITE_REF (default: the release tag).
set -euo pipefail
VERSION="v0.2.0"
REPO="${PGPT_LITE_REPO:-https://github.com/uengine-oss/process-gpt-lite.git}"
REF="${PGPT_LITE_REF:-$VERSION}"
DIR="${PGPT_LITE_DIR:-$HOME/process-gpt-lite}"
for c in git docker curl openssl; do
  command -v "$c" >/dev/null || { echo "[오류] $c 가 필요합니다." >&2; exit 1; }
done
case "$REF" in
  v[0-9]*) ;;
  *) echo "[주의] 릴리스 태그가 아닌 '$REF' 를 설치합니다. 브랜치는 내용이 바뀔 수 있습니다." >&2 ;;
esac
case "$REPO" in
  https://*) ;;
  *) echo "[오류] 저장소 주소는 https 여야 합니다: $REPO" >&2; exit 1 ;;
esac
if [ -d "$DIR/.git" ]; then
  echo "==> 기존 설치를 $REF 로 맞춥니다: $DIR"
  if git -C "$DIR" ls-remote --exit-code --tags "$REPO" "refs/tags/$REF" >/dev/null 2>&1; then
    git -C "$DIR" fetch -q --depth 1 origin "refs/tags/$REF:refs/tags/$REF"
    git -C "$DIR" -c advice.detachedHead=false checkout -q "refs/tags/$REF"
  else
    git -C "$DIR" fetch -q --depth 1 origin "$REF"
    git -C "$DIR" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
else
  echo "==> 내려받습니다: $REPO ($REF) → $DIR"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
echo "==> 설치할 버전: $REF ($(git -C "$DIR" rev-parse --short HEAD))"
cd "$DIR/install"
# piped through bash, stdin is this script: ask questions on the terminal when there is one
if [ -r /dev/tty ] && [ -t 1 ]; then exec ./install.sh "$@" </dev/tty; else exec ./install.sh "$@"; fi
