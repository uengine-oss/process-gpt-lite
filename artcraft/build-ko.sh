#!/bin/bash
# Build ArtCraft web apps with a Hangul UI fallback (patches/<app>-web-korean-font.patch).
#
# usage: artcraft/build-ko.sh cadcraft vectorcraft photocraft soundcraft filmcraft
#
# Expects upstream sources checked out under $ARTCRAFT_SRC/<app>-src with the patches applied
# (see README.md). Output: each app's packaging/web/package.sh result; copy or link it to
# artcraft/web/<app>/ (PRO_CRAFT_WEB_ROOT) so the pgpt-lite server serves it at /craft/<app>/.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ARTCRAFT_SRC="${ARTCRAFT_SRC:-$HERE/src}"
export PATH="$HOME/.cargo/bin:$PATH"
# NanumGothic (SIL OFL 1.1) — download it yourself, see README.md
export PGPT_KO_FONT="${PGPT_KO_FONT:-$HERE/fonts-ko/fonts/NanumGothic-Regular.ttf}"
# CADCraft/VectorCraft read the face list from $CRAFT_FONTS_DIR/fonts/manifest.txt
export CRAFT_FONTS_DIR="${CRAFT_FONTS_DIR:-$HERE/fonts-ko}"
LOG="${LOG_DIR:-${TMPDIR:-/tmp}}"
[ -f "$PGPT_KO_FONT" ] || { echo "missing Korean font: $PGPT_KO_FONT"; exit 1; }
for a in "$@"; do
  echo "== $a $(date +%T)"
  extra=""; [ "$a" = filmcraft ] && extra="CI=1"
  (cd "$ARTCRAFT_SRC/$a-src" && env $extra CARGO_TARGET_DIR="$ARTCRAFT_SRC/target-$a" bash packaging/web/package.sh > "$LOG/$a-build.log" 2>&1; echo "$a exit $?")
  tail -2 "$LOG/$a-build.log"
done
