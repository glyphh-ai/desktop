#!/bin/bash
# Build glyphh-window-helper as a universal (arm64 + x86_64) macOS binary.
# Output: native/mac-window-helper/build/glyphh-window-helper
# Requires Xcode Command Line Tools (swiftc). No-ops on non-macOS.
set -euo pipefail

[ "$(uname)" = "Darwin" ] || { echo "[mac-helper] not macOS — skipping"; exit 0; }
command -v swiftc >/dev/null || { echo "[mac-helper] swiftc not found — install Xcode Command Line Tools (xcode-select --install)"; exit 1; }

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$DIR/native/mac-window-helper/main.swift"
OUT="$DIR/native/mac-window-helper/build"
mkdir -p "$OUT"

# Skip if up to date (source older than binary).
if [ -f "$OUT/glyphh-window-helper" ] && [ "$SRC" -ot "$OUT/glyphh-window-helper" ]; then
  echo "[mac-helper] up to date"
  exit 0
fi

echo "[mac-helper] compiling (arm64 + x86_64)…"
swiftc -O -target arm64-apple-macos12 -o "$OUT/helper-arm64" "$SRC"
swiftc -O -target x86_64-apple-macos12 -o "$OUT/helper-x64" "$SRC"
lipo -create -output "$OUT/glyphh-window-helper" "$OUT/helper-arm64" "$OUT/helper-x64"
rm -f "$OUT/helper-arm64" "$OUT/helper-x64"
chmod +x "$OUT/glyphh-window-helper"
echo "[mac-helper] built $OUT/glyphh-window-helper ($(lipo -archs "$OUT/glyphh-window-helper"))"
