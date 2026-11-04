#!/usr/bin/env bash
# Builds the SolidCraft web app (Chili3D + our bridge plugin) into artcraft/web/solidcraft/ and hands
# the same WASM kernel to solidcraft-cli. Chili3D's source stays untouched.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHILI="${CHILI3D_SRC:-$HERE/../../../artcraft/chili3d-src}"
WEB="${SOLIDCRAFT_WEB_DIR:-$HERE/../../../artcraft/web/solidcraft}"
CHILI="$(cd "$CHILI" && pwd)"
BUILD="$HERE/.build/dist"
CLI_VENDOR="$HERE/../solidcraft-cli/vendor/chili-wasm"

version="$(node -p "require('$CHILI/package.json').version")"
commit="$(git -C "$CHILI" rev-parse HEAD)"

echo "== building Chili3D $version ($commit)"
(cd "$CHILI" && NODE_ENV=production CHILI3D_SRC="$CHILI" SOLIDCRAFT_BUILD_DIR="$BUILD" \
  npx rspack build -c "$HERE/rspack.solidcraft.config.mjs")

echo "== adding the bridge plugin and notices"
perl -pi -e "s/__CHILI3D_VERSION__/$version/" "$BUILD/index.html"
rm -rf "$BUILD/plugins"
mkdir -p "$BUILD/plugins"
cp -R "$HERE/plugin/solidcraft-bridge" "$BUILD/plugins/solidcraft-bridge"
printf '{ "plugins": ["solidcraft-bridge"] }\n' > "$BUILD/plugins/plugins.json"
# nothing here asks for these once the welcome screen has no videos
rm -f "$BUILD/videos.json"
cp "$CHILI/LICENSE" "$BUILD/LICENSE.txt"
sed -e "s/__CHILI3D_VERSION__/$version/g" -e "s/__CHILI3D_COMMIT__/$commit/g" "$HERE/NOTICE.txt" > "$BUILD/NOTICE.txt"

# server/index.js serves <file>.gz for .js and .wasm when the browser takes gzip
find "$BUILD" -type f \( -name '*.js' -o -name '*.wasm' \) -exec gzip -9 -k -f {} \;

echo "== installing to $WEB"
mkdir -p "$(dirname "$WEB")"
rm -rf "$WEB.new"
cp -R "$BUILD" "$WEB.new"
rm -rf "$WEB"
mv "$WEB.new" "$WEB"

echo "== handing the kernel to solidcraft-cli"
mkdir -p "$CLI_VENDOR"
cp "$CHILI/packages/wasm/lib/chili-wasm.js" "$CHILI/packages/wasm/lib/chili-wasm.wasm" "$CLI_VENDOR/"
cp "$HERE/NOTICE.txt" "$CLI_VENDOR/NOTICE.txt"
perl -pi -e "s/__CHILI3D_VERSION__/$version/g; s/__CHILI3D_COMMIT__/$commit/g" "$CLI_VENDOR/NOTICE.txt"

du -sh "$WEB"
echo "done"
