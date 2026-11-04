#!/usr/bin/env bash
# Build orcad2json against an already built OpenOrCadParser.
#
#   craft/orcad/build.sh            builds artcraft/orcad2json
#   ARTCRAFT=/path craft/orcad/build.sh    uses another artcraft directory
#
# The parser's sources are not changed. Its object files are linked statically,
# so the result does not need libOpenOrCadParser.dylib at run time.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
artcraft="${ARTCRAFT:-$(cd "$here/../../.." && pwd)/artcraft}"
src="$artcraft/openorcad-src"
build="$src/build"
out="${OUT:-$artcraft/orcad2json}"

if [ ! -d "$build/lib/CMakeFiles/OpenOrCadParser.dir" ]; then
  echo "OpenOrCadParser is not built yet. Build it first:" >&2
  echo "  cd $src" >&2
  echo "  export VCPKG_ROOT=$artcraft/vcpkg" >&2
  echo "  cmake --preset release -G Ninja -DCMAKE_MAKE_PROGRAM=\$(command -v ninja)" >&2
  echo "  CMAKE_BUILD_PARALLEL_LEVEL=8 cmake --build --preset release" >&2
  exit 1
fi

triplet_dir="$(find "$build/vcpkg_installed" -mindepth 1 -maxdepth 1 -type d ! -name vcpkg | head -n 1)"
if [ -z "$triplet_dir" ]; then
  echo "vcpkg_installed not found under $build" >&2
  exit 1
fi

# Flags taken from the parser's own compile_commands.json.
cxx="${CXX:-c++}"
flags=(-std=gnu++20 -O2 -DNDEBUG -DSPDLOG_COMPILED_LIB -DSPDLOG_FMT_EXTERNAL -D_FILE_OFFSET_BITS=64)
incs=(-I"$src/src" -isystem "$triplet_dir/include")

objdir="$(mktemp -d "${TMPDIR:-/tmp}/orcad2json-build.XXXXXX")"
trap 'rm -rf "$objdir"' EXIT

"$cxx" "${flags[@]}" "${incs[@]}" -c "$here/orcad2json.cpp" -o "$objdir/orcad2json.o"

objs=()
while IFS= read -r -d '' f; do objs+=("$f"); done \
  < <(find "$build/lib/CMakeFiles/OpenOrCadParser.dir" -name '*.o' -print0)

"$cxx" "$objdir/orcad2json.o" "${objs[@]}" \
  "$triplet_dir/lib/libspdlog.a" "$triplet_dir/lib/libfmt.a" "$triplet_dir/lib/libtinyxml2.a" \
  -o "$out"

echo "built $out"
