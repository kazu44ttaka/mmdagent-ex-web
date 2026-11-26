#!/usr/bin/env bash
# Build Julius (the copy bundled with MMDAgent-EX) to WebAssembly for lip sync.
#
#   julius/build.sh <MMDAgent-EX source folder> [emsdk folder]
#
# Needs Emscripten (emsdk). Writes julius/dist/julius.js and julius.wasm, and copies
# the phoneme model and jconf from MMDAgent-EX's Release/AppData/Julius to appdata/julius.
set -euo pipefail

MMDEX="${1:?usage: build.sh <MMDAgent-EX source> [emsdk]}"
EMSDK="${2:-${EMSDK:-C:/emsdk}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$MMDEX/Library_Julius/src"
WORK="$HERE/work"
OUT="$HERE/dist"

if [ -f "$EMSDK/emsdk_env.sh" ]; then
  # shellcheck disable=SC1091
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1 || true
fi
EMCC="${EMCC:-emcc}"
command -v "$EMCC" > /dev/null || { echo "emcc not found (activate emsdk)"; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK" "$OUT"
cp -r "$SRC/libjulius" "$SRC/libsent" "$WORK/"

# configuration: the pregenerated Ubuntu one without ALSA / OSS; USE_MIC stays so that
# "-input mic" in MMDAgent-EX's jconf is accepted (jw.c provides the adin_mic_* functions)
for f in "$WORK/libsent/include/sent/config-ubuntu-libsent.h"; do
  sed -i -e '/HAVE_SYS_SOUNDCARD_H/d' -e '/HAVE_ALSA_ASOUNDLIB_H/d' \
         -e 's/#define AUDIO_API_NAME .*/#define AUDIO_API_NAME "browser"/' \
         -e 's/#define AUDIO_API_DESC .*/#define AUDIO_API_DESC "audio pushed from JavaScript"/' "$f"
done

# no x86 CPU detection in WebAssembly (only the DNN code uses it, and the phoneme model is a GMM)
sed -i 's/#if defined(__arm__) || TARGET_OS_IPHONE || defined(__aarch64__)/#if defined(__arm__) || TARGET_OS_IPHONE || defined(__aarch64__) || defined(__EMSCRIPTEN__)/'   "$WORK/libsent/src/phmm/calc_dnn.c"

SOURCES=$(sed -n '/^set(SOURCES/,/^)/p' "$MMDEX/Library_Julius/CMakeLists.txt" \
  | grep -o 'src/[^ ]*\.c' | sed 's#^src/##' | grep -v 'adin_portaudio.c')

FILES=()
for s in $SOURCES; do FILES+=("$WORK/$s"); done

"$EMCC" -O2 -DUSE_PREGENERATED_CONFIG_UBUNTU=1 \
  -I"$WORK/libjulius/include" -I"$WORK/libsent/include" -I"$WORK/libjulius/libfvad/include" \
  -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-everything \
  -sUSE_ZLIB=1 -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=65536 -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 \
  -sMODULARIZE=1 -sEXPORT_NAME=createJulius -sENVIRONMENT=worker,node \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_jw_init,_jw_run,_jw_feed,_jw_set_streaming,_jw_segment,_jw_clear,_jw_delivered \
  -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString,HEAP16 \
  "$HERE/jw.c" "${FILES[@]}" -o "$OUT/julius.js"

mkdir -p "$HERE/../appdata/julius/phoneseq"
cp "$MMDEX/Release/AppData/Julius/jconf_phone.txt" "$HERE/../appdata/julius/"
cp "$MMDEX/Release/AppData/Julius/phoneseq/"* "$HERE/../appdata/julius/phoneseq/"
cp "$SRC/LICENSE" "$HERE/../appdata/julius/LICENSE-Julius.txt"
cp "$SRC/libjulius/libfvad/libfvad/LICENSE" "$HERE/../appdata/julius/LICENSE-libfvad.txt"
echo "built $OUT/julius.js and julius.wasm"
