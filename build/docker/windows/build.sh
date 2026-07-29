#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG must be a v-prefixed version tag}"

mkdir -p /build/source /artifacts "$XWIN_CACHE_DIR"

# Tauri's Windows MSVC cross-build needs a writable source tree while the
# mounted repository remains immutable on the host.
tar \
  --exclude='./.git' \
  --exclude='./artifacts' \
  --exclude='./dist' \
  --exclude='./node_modules' \
  --exclude='./src-tauri/target' \
  --exclude='./target' \
  -C /workspace \
  -cf - \
  . |
  tar -C /build/source -xf -

cd /build/source

version="$(node build/scripts/release-tools.mjs verify-version "$RELEASE_TAG" .)"

npm ci
npm test
npm run test:release
# The Linux builder owns native-target Rust tests. Running them again through
# x86 emulation adds no Windows coverage and makes PTY timing tests unreliable.
npm run tauri -- build \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc \
  --bundles nsis

node build/scripts/release-tools.mjs collect \
  windows-x86_64 \
  "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle" \
  /artifacts \
  "$version"

find /artifacts -maxdepth 1 -type f -print
