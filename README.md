# Anchor

Managed terminal sessions for AI CLIs — run many Claude Code / Codex / GitHub
Copilot CLI / opencode sessions across many directories, and **resume every one
of them with a click after an app restart or OS reboot**. Each session's
identity (tool, working directory, CLI session ID) is persisted the moment it
launches. Resume always targets that exact saved ID; Anchor never opens an AI
provider's interactive session picker. CLI detection and spawning share one
resolver, including common user-level install locations omitted by desktop app
launch environments.

## Docs

- **[docs/SPEC.md](docs/SPEC.md)** — the single source of truth (product,
  architecture, IPC contract, phases).
- **[docs/Anchor.dc.html](docs/Anchor.dc.html)** — authoritative UI mock (open
  in a browser). The app must be built to this mock.

## Stack

Tauri v2 · Rust core (PTYs via `portable-pty`, session registry, CLI adapters)
· React + TypeScript + Vite · xterm.js.

## Status

**Phase 1 (scaffold) complete.** Phase 2 (Rust backend) and Phase 3 (frontend
to the mock) are specified in [docs/SPEC.md §10](docs/SPEC.md).

## Development

Prerequisites: Node ≥ 20, Rust (stable), plus
[Tauri v2 OS prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev    # run the app
npm run build        # typecheck + bundle frontend
cd src-tauri && cargo check   # check Rust core
```

Frontend-only development without Rust: `VITE_IPC=mock npm run dev`.

## Reproducible release builds

Linux and Windows release builds use repository-owned Docker images. They do
not use Node, Rust, Tauri, WebKit, LLVM, or NSIS from the host.

Linux x86_64:

```sh
mkdir -p artifacts/linux-x86_64
RELEASE_TAG=v0.1.0 docker compose run --rm --build linux-x86_64
```

Output:

```text
artifacts/linux-x86_64/Anchor_0.1.0_linux_x86_64.AppImage
artifacts/linux-x86_64/Anchor_0.1.0_linux_x86_64.deb
artifacts/linux-x86_64/Anchor_0.1.0_linux_x86_64.rpm
```

Windows x86_64:

```sh
mkdir -p artifacts/windows-x86_64
RELEASE_TAG=v0.1.0 docker compose run --rm --build windows-x86_64
```

Output:

```text
artifacts/windows-x86_64/Anchor_0.1.0_windows_x86_64-setup.exe
```

The Windows image follows
[Tauri's documented `cargo-xwin` NSIS path](https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos).
MSI packages are not included because Tauri requires Windows and WiX to create
them. Both builders run as Linux x86_64 containers. Docker Desktop can emulate
that platform on an ARM64 Mac, but the first build is slower. Local emulated
builds compile the full Rust application but skip native PTY timing tests. The
GitHub Linux job enables those tests on its native x86_64 runner. On a native
x86_64 Docker host, use `RUN_NATIVE_RUST_TESTS=1` to enable them locally.

The source checkout is mounted read-only. Package-manager and compiler caches
live in Docker volumes. Only the normalized files under `artifacts/` are
written to the host.

### macOS and GitHub releases

Docker Desktop on macOS runs Linux containers, so it cannot provide Apple's
native application and DMG toolchain. The release workflow uses clean native
GitHub macOS runners for Apple Silicon and Intel builds. It does not install
build dependencies on the developer's Mac.

Pushing a version tag starts `.github/workflows/release.yml`:

```sh
git tag -a v0.1.0 -m "Anchor 0.1.0"
git push origin v0.1.0
```

The workflow publishes only after all six platform packages exist and the
release inventory is exact. The release also contains `SHA256SUMS.txt`:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Version `0.1.0` is an unsigned preview. The macOS DMGs use ad-hoc signing but
are not notarized, so Gatekeeper can require manual approval. Windows can show
an unknown-publisher warning.
