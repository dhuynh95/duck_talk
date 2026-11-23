#!/usr/bin/env bash
# Installs the local voice for Duck Talk: Kokoro-82M, run through kokoro-onnx on the CPU.
#
#   bash install.sh
#
# Everything goes in one private folder — a Python environment and the model, about 450 MB —
# and nothing outside it is touched:
#
#   ${KOKORO_HOME:-~/.local/share/duck-talk/kokoro}/venv     the Python packages
#   ${KOKORO_HOME:-~/.local/share/duck-talk/kokoro}/models   kokoro-v1.0.onnx, voices-v1.0.bin
#
# The model files come from the kokoro-onnx project's GitHub release and are checked against
# the hashes below, which are those of the files this was written against. To remove it all:
# delete the folder.
set -euo pipefail

DIR="${KOKORO_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/duck-talk/kokoro}"
RELEASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
PACKAGE="kokoro-onnx==0.6.1"
MODEL_SHA256="7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"
VOICES_SHA256="bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"

command -v python3 >/dev/null || { echo "python3 is needed (3.10 or newer)." >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || { echo "python3 is older than 3.10." >&2; exit 1; }
python3 -m venv --help >/dev/null 2>&1 || { echo "python3 has no venv module — on Debian/Ubuntu: sudo apt install python3-venv" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is needed." >&2; exit 1; }

mkdir -p "$DIR/models"

if [ ! -x "$DIR/venv/bin/python" ]; then
  echo "• creating the Python environment"
  python3 -m venv "$DIR/venv"
fi
echo "• installing $PACKAGE"
"$DIR/venv/bin/pip" install --quiet --disable-pip-version-check "$PACKAGE"

fetch() { # name, sha256
  local file="$DIR/models/$1"
  if [ -f "$file" ] && [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$2" ]; then
    echo "• $1 is already here"
    return
  fi
  echo "• downloading $1"
  curl -fL --retry 3 --max-time 1800 -sS -o "$file.part" "$RELEASE/$1"
  local got
  got="$(sha256sum "$file.part" | cut -d' ' -f1)"
  if [ "$got" != "$2" ]; then
    rm -f "$file.part"
    echo "$1 does not match the expected hash (got $got) — not installed." >&2
    exit 1
  fi
  mv "$file.part" "$file"
}
fetch kokoro-v1.0.onnx "$MODEL_SHA256"
fetch voices-v1.0.bin "$VOICES_SHA256"

echo "• checking that it speaks"
"$DIR/venv/bin/python" - "$DIR/models" <<'PY'
import os, sys, time
from kokoro_onnx import Kokoro
d = sys.argv[1]
k = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
t = time.time()
samples, rate = k.create("Duck Talk can speak.", voice="af_heart", lang="en-us")
assert rate == 24000 and len(samples) > 0
print(f"  ok — {len(samples) / rate:.1f}s of speech in {time.time() - t:.1f}s")
PY

echo
echo "Installed in $DIR"
echo "Choose it in the page: gear menu → Local voice (Kokoro). The relay starts it when it is needed."
