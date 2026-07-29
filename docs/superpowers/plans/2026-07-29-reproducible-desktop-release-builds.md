# Reproducible Desktop Release Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Anchor 0.1.0 for Linux, Windows, and macOS without installing build dependencies on the developer's Mac, then publish verified assets as GitHub release `v0.1.0`.

**Architecture:** Linux and Windows NSIS artifacts are produced by repository-owned Linux containers. Windows uses Tauri's documented `cargo-xwin` cross-build path. GitHub-hosted native macOS runners create Apple Silicon and Intel DMGs. Build jobs upload isolated workflow artifacts; a final job verifies the complete inventory, generates checksums, and publishes one release.

**Tech Stack:** Docker Compose, Debian Bookworm containers, Node.js 22, Rust stable, Tauri v2, cargo-xwin, NSIS, GitHub Actions, Node.js built-in test runner.

---

### Task 1: Release Contract Tool

**Files:**
- Create: `build/scripts/release-tools.mjs`
- Create: `build/scripts/release-tools.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing contract tests**

Create tests with `node:test` that use synthetic temporary directories and
cover:

```js
test('accepts a tag that matches both project versions', async () => {
  const root = await makeProject('0.1.0', '0.1.0')
  assert.equal(await verifyVersion(root, 'v0.1.0'), '0.1.0')
})

test('rejects mismatched project versions', async () => {
  const root = await makeProject('0.1.0', '0.2.0')
  await assert.rejects(() => verifyVersion(root, 'v0.1.0'), /version mismatch/)
})

test('collects one artifact for every platform package type', async () => {
  const fixture = await makeBundleFixture()
  const copied = await collectArtifacts({
    platform: 'linux-x86_64',
    source: fixture.source,
    destination: fixture.destination,
    version: '0.1.0',
  })
  assert.deepEqual(copied.map(path.basename), [
    'Anchor_0.1.0_linux_x86_64.AppImage',
    'Anchor_0.1.0_linux_x86_64.deb',
    'Anchor_0.1.0_linux_x86_64.rpm',
  ])
})

test('rejects incomplete final inventories', async () => {
  const root = await makeInventoryFixture({ omit: 'Anchor_0.1.0_macos_x86_64.dmg' })
  await assert.rejects(() => writeChecksums(root, '0.1.0'), /missing release artifact/)
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test build/scripts/release-tools.test.mjs
```

Expected: fail because `release-tools.mjs` does not exist.

- [ ] **Step 3: Implement the release contract**

Export:

```js
export async function verifyVersion(root, tag)
export async function collectArtifacts({ platform, source, destination, version })
export async function writeChecksums(root, version)
```

The platform contract must be:

```js
const platformContracts = {
  'linux-x86_64': [
    ['.AppImage', `Anchor_${version}_linux_x86_64.AppImage`],
    ['.deb', `Anchor_${version}_linux_x86_64.deb`],
    ['.rpm', `Anchor_${version}_linux_x86_64.rpm`],
  ],
  'windows-x86_64': [
    ['-setup.exe', `Anchor_${version}_windows_x86_64-setup.exe`],
  ],
  'macos-aarch64': [
    ['.dmg', `Anchor_${version}_macos_aarch64.dmg`],
  ],
  'macos-x86_64': [
    ['.dmg', `Anchor_${version}_macos_x86_64.dmg`],
  ],
}
```

The CLI must support:

```bash
node build/scripts/release-tools.mjs verify-version <tag> [root]
node build/scripts/release-tools.mjs collect <platform> <source> <destination> <version>
node build/scripts/release-tools.mjs checksums <root> <version>
```

`checksums` must reject missing or extra files before writing
`SHA256SUMS.txt`. It must stream file content through SHA-256 and sort entries
by file name.

- [ ] **Step 4: Add and run the script test command**

Add:

```json
"test:release": "node --test build/scripts/release-tools.test.mjs"
```

Run:

```bash
npm run test:release
```

Expected: all release-tool tests pass.

- [ ] **Step 5: Commit**

```bash
git add build/scripts package.json
git commit -m "build: add release artifact contract"
```

### Task 2: Linux Docker Builder

**Files:**
- Create: `build/docker/linux/Dockerfile`
- Create: `build/docker/linux/build.sh`
- Create: `.dockerignore`
- Create: `compose.yaml`

- [ ] **Step 1: Add the Linux builder image**

Use a Node 22 Bookworm stage and Rust Bookworm runtime:

```dockerfile
FROM node:22-bookworm-slim AS node
FROM rust:1-bookworm

COPY --from=node /usr/local/ /usr/local/

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential curl file libayatana-appindicator3-dev libfuse2 \
    librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev patchelf rpm \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

ENV APPIMAGE_EXTRACT_AND_RUN=1
ENV CARGO_TARGET_DIR=/build/target
COPY build/docker/linux/build.sh /usr/local/bin/anchor-build-linux
ENTRYPOINT ["/usr/local/bin/anchor-build-linux"]
```

The image-layer cleanup is limited to package-manager cache created inside the
container image. It never touches repository or host files.

- [ ] **Step 2: Add the isolated build entrypoint**

`build.sh` must:

1. Copy the read-only `/workspace` mount to a new `/build/source` directory
   without `.git`, `node_modules`, `target`, `dist`, or `artifacts`.
2. Verify `RELEASE_TAG`.
3. Run `npm ci`, frontend tests, release-tool tests, locked Rust tests, and
   locked `cargo check`.
4. Run `npm run tauri -- build --bundles appimage,deb,rpm`.
5. Collect the three normalized artifacts into `/artifacts`.

- [ ] **Step 3: Add the Compose service**

`compose.yaml` must define:

```yaml
services:
  linux-x86_64:
    platform: linux/amd64
    build:
      context: .
      dockerfile: build/docker/linux/Dockerfile
    environment:
      RELEASE_TAG: ${RELEASE_TAG:-v0.1.0}
    volumes:
      - type: bind
        source: .
        target: /workspace
        read_only: true
      - type: bind
        source: ./artifacts/linux-x86_64
        target: /artifacts
      - anchor-linux-npm-cache:/root/.npm
      - anchor-linux-cargo-registry:/usr/local/cargo/registry
      - anchor-linux-cargo-git:/usr/local/cargo/git

volumes:
  anchor-linux-npm-cache:
  anchor-linux-cargo-registry:
  anchor-linux-cargo-git:
```

The Windows service is added in Task 3.

- [ ] **Step 4: Validate without installing host dependencies**

Run:

```bash
docker compose config
docker build --check -f build/docker/linux/Dockerfile .
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add .dockerignore compose.yaml build/docker/linux
git commit -m "build: add Linux container builder"
```

### Task 3: Windows NSIS Cross-Builder

**Files:**
- Create: `build/docker/windows/Dockerfile`
- Create: `build/docker/windows/build.sh`
- Modify: `compose.yaml`

- [ ] **Step 1: Add the Windows cross-builder image**

Base it on the same Node/Rust pairing as the Linux builder. Install:

```text
clang
lld
llvm
nsis
libwebkit2gtk-4.1-dev
```

Then run:

```dockerfile
RUN rustup target add x86_64-pc-windows-msvc \
  && cargo install --locked cargo-xwin
```

Set `XWIN_CACHE_DIR=/xwin-cache` and
`CARGO_TARGET_DIR=/build/target`.

- [ ] **Step 2: Add the Windows build entrypoint**

`build.sh` must use a new container-local source copy, run the same tests and
checks, and build:

```bash
npm run tauri -- build \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc \
  --bundles nsis
```

Collect exactly one `-setup.exe` from
`/build/target/x86_64-pc-windows-msvc/release/bundle`.

- [ ] **Step 3: Add the Compose service**

Add:

```yaml
  windows-x86_64:
    platform: linux/amd64
    build:
      context: .
      dockerfile: build/docker/windows/Dockerfile
    environment:
      RELEASE_TAG: ${RELEASE_TAG:-v0.1.0}
    volumes:
      - type: bind
        source: .
        target: /workspace
        read_only: true
      - type: bind
        source: ./artifacts/windows-x86_64
        target: /artifacts
      - anchor-windows-npm-cache:/root/.npm
      - anchor-windows-cargo-registry:/usr/local/cargo/registry
      - anchor-windows-cargo-git:/usr/local/cargo/git
      - anchor-windows-xwin-cache:/xwin-cache
```

Declare all four named volumes.

- [ ] **Step 4: Validate the image definition**

Run:

```bash
docker compose config
docker build --check -f build/docker/windows/Dockerfile .
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add compose.yaml build/docker/windows
git commit -m "build: add Windows NSIS cross-builder"
```

### Task 4: GitHub Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Add tag and manual triggers**

Use:

```yaml
on:
  push:
    tags:
      - "v*"
  workflow_dispatch:
    inputs:
      tag:
        description: Existing v-prefixed tag to release
        required: true
        type: string
```

Grant `contents: write` only to the final release job. Use concurrency keyed by
the selected tag.

- [ ] **Step 2: Add Linux and Windows container jobs**

Both jobs run on `ubuntu-24.04`. They check out the selected tag, create the
host artifact directory, and call:

```bash
RELEASE_TAG="$RELEASE_TAG" docker compose run --rm linux-x86_64
RELEASE_TAG="$RELEASE_TAG" docker compose run --rm windows-x86_64
```

Upload each output with `actions/upload-artifact`.

- [ ] **Step 3: Add native macOS matrix builds**

Use this matrix:

```yaml
include:
  - runner: macos-15
    target: aarch64-apple-darwin
    platform: macos-aarch64
  - runner: macos-15-intel
    target: x86_64-apple-darwin
    platform: macos-x86_64
```

Each job must:

1. Verify the version contract.
2. Use Node 22 and Rust stable with the matrix target.
3. Run `npm ci`, all frontend tests, release-tool tests, locked Rust tests, and
   locked `cargo check`.
4. Set `APPLE_SIGNING_IDENTITY: "-"`.
5. Build `--target <target> --bundles dmg`.
6. Normalize the DMG name with `release-tools.mjs collect`.
7. Upload the artifact.

- [ ] **Step 4: Add the final release job**

The final job depends on all four builds, downloads them into
`release-assets/`, runs:

```bash
node build/scripts/release-tools.mjs checksums release-assets "$VERSION"
```

It then creates or updates a draft release for the exact tag, uploads all
assets with `--clobber`, and changes the release to public/latest only after the
upload succeeds. Release notes must state that artifacts are unsigned and
include checksum verification commands.

- [ ] **Step 5: Validate YAML and commit**

Parse the workflow with the Ruby YAML parser already present on macOS, inspect
the diff for untrusted tag interpolation, and commit:

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish verified desktop releases"
```

### Task 5: User Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-29-reproducible-desktop-release-builds-design.md`

- [ ] **Step 1: Document local container builds**

Add exact Linux and Windows commands, output directories, cache behavior,
Docker platform requirements, and the fact that no host Node/Rust toolchain is
used.

- [ ] **Step 2: Document macOS and signing limits**

Explain why macOS uses native GitHub-hosted runners, the unsigned/ad-hoc status,
and the operating-system warnings users may see.

- [ ] **Step 3: Document release operation**

Document tag-driven publication, expected assets, and:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

- [ ] **Step 4: Verify public-repository safety and commit**

Scan the full diff for secrets, real local paths, private configuration, and
personal email addresses. Run `git diff --check`, then commit:

```bash
git add README.md docs/superpowers/specs/2026-07-29-reproducible-desktop-release-builds-design.md
git commit -m "docs: explain containerized release builds"
```

### Task 6: Local Container Validation

**Files:**
- No tracked file changes expected unless validation exposes a defect.

- [ ] **Step 1: Run static validation**

```bash
npm run test:release
docker compose config
docker build --check -f build/docker/linux/Dockerfile .
docker build --check -f build/docker/windows/Dockerfile .
git diff --check
```

- [ ] **Step 2: Build Linux through Compose**

```bash
mkdir -p artifacts/linux-x86_64
RELEASE_TAG=v0.1.0 docker compose run --rm --build linux-x86_64
```

Expected: AppImage, DEB, and RPM files with normalized names.

- [ ] **Step 3: Build Windows through Compose**

```bash
mkdir -p artifacts/windows-x86_64
RELEASE_TAG=v0.1.0 docker compose run --rm --build windows-x86_64
```

Expected: one normalized NSIS setup executable.

- [ ] **Step 4: Inspect artifacts**

Use `file`, sizes, and recursive inventory. Run the release collector tests
again. Do not commit `artifacts/`.

### Task 7: Publish and Verify v0.1.0

**Files:**
- No additional tracked changes expected unless CI exposes a defect.

- [ ] **Step 1: Run final source verification**

Run release-tool tests, project tests through the containers, Compose
validation, workflow YAML parsing, privacy scans, `git diff --check`, and
confirm a clean tracked worktree.

- [ ] **Step 2: Integrate and push**

Fast-forward `main` to `codex/release-builders`, push `main`, and verify local
and remote commit hashes match.

- [ ] **Step 3: Tag and monitor**

Create annotated tag `v0.1.0`, push it, and monitor the release workflow until
all jobs reach terminal success or a concrete defect is found. Fix defects,
retag only if the tag has not produced a public release, and continue until the
workflow succeeds.

- [ ] **Step 4: Verify the published release**

Confirm:

```text
Anchor_0.1.0_linux_x86_64.AppImage
Anchor_0.1.0_linux_x86_64.deb
Anchor_0.1.0_linux_x86_64.rpm
Anchor_0.1.0_windows_x86_64-setup.exe
Anchor_0.1.0_macos_aarch64.dmg
Anchor_0.1.0_macos_x86_64.dmg
SHA256SUMS.txt
```

Download all assets to a new temporary directory and verify every SHA-256
entry. Confirm the release targets the pushed `v0.1.0` commit and is public and
latest.
