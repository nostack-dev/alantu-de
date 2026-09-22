#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$ROOT/data"
mkdir -p "$DATA_DIR"
ZIP="$DATA_DIR/FI-2010-data.zip"
URL='https://raw.githubusercontent.com/zcakhaa/DeepLOB-Deep-Convolutional-Neural-Networks-for-Limit-Order-Books/ff14d7c2fd38bdfc143389786993d0f0236d4eb8/data/data.zip'
EXPECTED_GIT_SHA='2d8d7749caf622dd07e0df954413dc698129c766'

if [ ! -f "$ZIP" ]; then
  curl -fL --retry 4 --connect-timeout 15 --max-time 300 "$URL" -o "$ZIP"
fi

ACTUAL_GIT_SHA="$(git hash-object "$ZIP")"
test "$ACTUAL_GIT_SHA" = "$EXPECTED_GIT_SHA" || {
  echo "Dataset hash mismatch: $ACTUAL_GIT_SHA" >&2
  exit 2
}

rm -rf "$DATA_DIR/unpacked"
mkdir -p "$DATA_DIR/unpacked"
unzip -q "$ZIP" -d "$DATA_DIR/unpacked"
python - <<'PY'
try:
    import numpy
except Exception:
    raise SystemExit("NumPy missing. Install with: python -m pip install numpy")
PY

python "$ROOT/../../tools/validate-fi2010-microstructure.py"   "$DATA_DIR/unpacked"   "$ROOT/fi2010-microstructure-proof.json"   "$ROOT/fi2010-microstructure-model.json"

echo "Reproduced:"
echo "  $ROOT/fi2010-microstructure-proof.json"
echo "  $ROOT/fi2010-microstructure-model.json"
