#!/bin/bash
# craft-build <app> <commit>: the upstream ArtCraft app at <commit> with artcraft/patches/<app>-*.patch,
# its web editor (packaging/web/package.sh) and its MCP CLI, left in /out/web/<app> and /out/bin.
set -euo pipefail
app=$1 commit=$2
src=/src/$app web=/tmp/web-$app
git clone -q --filter=blob:none "https://github.com/storytold/$app" "$src"
git -C "$src" checkout -q "$commit"
for p in /patches/"$app"-*.patch; do git -C "$src" apply "$p"; done
cd "$src"
# filmcraft's package.sh skips its interactive checks under CI
[ "$app" = filmcraft ] && export CI=1
# photocraft's package.sh names the JS glue after the wasm's hash, but Trunk hashes the wasm again
# after wasm-opt: take the one glue file there is (the site copies it to a fixed name anyway)
if [ "$app" = photocraft ]; then
  sed -i 's#^GLUE="\$APP/\$STEM\.js"#GLUE="$(ls "$APP"/photocraft-web-*.js | head -1)"#' packaging/web/package.sh
  grep -q 'photocraft-web-\*\.js' packaging/web/package.sh
fi
bash packaging/web/package.sh
zip=$(find "$src/dist" -name "$app-web-*.zip" | head -1)
mkdir -p "/out/web/$app" /out/bin "$web"
unzip -q "$zip" -d "$web"
cp -a "$(dirname "$(find "$web" -name index.html | head -1)")"/. "/out/web/$app"/
cargo build --release -p "$app-cli"
cp "$CARGO_TARGET_DIR/release/$app-cli" /out/bin/
