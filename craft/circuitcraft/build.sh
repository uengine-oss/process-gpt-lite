#!/bin/sh
# Build CircuitCraft and put it where the Process GPT Lite server serves /craft/circuitcraft/ from.
#   ./build.sh                       (default target: ../../../artcraft/web/circuitcraft)
#   CIRCUITCRAFT_WEB_DIR=/path ./build.sh
set -e
cd "$(dirname "$0")"
TARGET="${CIRCUITCRAFT_WEB_DIR:-../../../artcraft/web/circuitcraft}"

[ -x node_modules/.bin/vite ] || pnpm install --ignore-workspace --frozen-lockfile
npx vite build </dev/null

mkdir -p "$TARGET"
rsync -a --delete build/ "$TARGET/"
# the server's /craft route sends <file>.gz when it exists: the engine worker is 19 MB of JavaScript
find "$TARGET" -type f -name '*.js' -size +512k -exec gzip -9 -k -f {} \;

echo "CircuitCraft is in $(cd "$TARGET" && pwd)"
du -sh "$TARGET"
