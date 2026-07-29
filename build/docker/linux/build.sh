#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG must be a v-prefixed version tag}"

mkdir -p /build/source /artifacts

# The repository remains read-only; package managers and compilers only write
# into this fresh container-local copy and Docker-managed cache volumes.
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
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo check --manifest-path src-tauri/Cargo.toml --locked
npm run tauri -- build --bundles appimage,deb,rpm

node build/scripts/release-tools.mjs collect \
  linux-x86_64 \
  "$CARGO_TARGET_DIR/release/bundle" \
  /artifacts \
  "$version"

find /artifacts -maxdepth 1 -type f -print
