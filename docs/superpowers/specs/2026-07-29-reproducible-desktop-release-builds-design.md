# Reproducible Desktop Release Builds Design

**Status:** Approved on 2026-07-29

## Goal

Build Anchor 0.1.0 for Linux, Windows, and macOS without installing application
build dependencies on the developer's Mac, then publish the verified bundles
and checksums as GitHub release `v0.1.0`.

## Constraints

- Linux builds must run in the repository's Docker builder.
- Windows builds should run in the repository's Windows-container builder on a
  compatible Windows Docker host.
- GitHub-hosted runners do not support Windows Docker container jobs. The
  approved first-release exception is a clean GitHub-hosted Windows runner.
- macOS builds run on clean GitHub-hosted macOS runners. Docker Desktop for Mac
  runs Linux containers and cannot provide Apple's native bundle toolchain.
- No Node, Rust, Tauri, Linux GUI, or Windows build dependencies are installed
  on the developer's Mac.
- The existing Docker installation and Git/GitHub CLI may be used.
- The public repository must contain no secrets, personal data, or
  machine-specific absolute paths.

## Architecture

### Repository-owned builders

`build/docker/linux/Dockerfile` defines the complete Linux x86_64 Tauri build
environment. It pins the Node and Rust toolchain inputs, installs Tauri's Linux
system packages, uses `npm ci`, and writes only final bundles to a mounted
`artifacts/linux-x86_64/` directory.

`build/docker/windows/Dockerfile` and its PowerShell entrypoint define the
equivalent Windows x86_64 builder for a Windows Docker host. The image contains
the Microsoft C++ toolchain, WebView2 build requirements, Node, Rust MSVC, and
the Tauri CLI. This builder is a portable path for later Windows machines even
though the first GitHub-hosted release uses a native Windows VM.

The root `compose.yaml` exposes explicit `linux-x86_64` and
`windows-x86_64` services. Each service mounts the repository read-only and a
single writable artifact directory. Builders keep dependency caches in Docker
volumes, not in the host checkout.

### GitHub release workflow

`.github/workflows/release.yml` runs only for `v*` tags or an explicit manual
dispatch. It has separate build jobs:

1. Linux x86_64 runs the same Linux Dockerfile used by Compose.
2. Windows x86_64 runs on a clean GitHub Windows VM as the approved exception.
3. macOS Apple Silicon runs on a clean GitHub macOS ARM runner.
4. macOS Intel runs on a clean GitHub macOS Intel runner.

Each job checks that the tag version equals both `package.json` and
`src-tauri/tauri.conf.json`. Each build uses `npm ci`, the locked Rust
dependencies, and Tauri's release build. Jobs upload intermediate workflow
artifacts. A final release job downloads all bundles, rejects unexpected or
duplicate file names, generates `SHA256SUMS.txt`, and uploads the complete set
to one GitHub release.

The GitHub release starts as a draft. It becomes public only after every build,
test, artifact inventory, and checksum step succeeds.

## Release Artifacts

The target artifact set is:

- Linux x86_64: AppImage, Debian package, and RPM package.
- Windows x86_64: NSIS installer and MSI installer when the hosted Windows
  image supports Tauri's MSI prerequisites. A failed required package fails the
  workflow; it is not silently omitted.
- macOS Apple Silicon: DMG.
- macOS Intel: DMG.
- All platforms: `SHA256SUMS.txt`.

Artifact names include product, version, operating system, architecture, and
package type so the two macOS builds cannot overwrite one another.

The first release is unsigned and not notarized because no signing credentials
were provided. The release notes must state this clearly. macOS uses Tauri's
documented ad-hoc signing mode so downloaded Apple Silicon bundles are not
treated as structurally unsigned.

## Data Flow

```text
v0.1.0 tag
    |
    +--> Linux Docker build --------+
    +--> Windows hosted VM build ---+--> inventory + SHA-256 --> draft release
    +--> macOS ARM hosted build ----+
    +--> macOS Intel hosted build --+
```

Local use follows the same Linux container path:

```text
docker compose run --rm linux-x86_64
    -> artifacts/linux-x86_64/
```

On a compatible Windows Docker host:

```text
docker compose run --rm windows-x86_64
    -> artifacts/windows-x86_64/
```

## Failure Handling

- A version mismatch stops before compilation.
- A test, type-check, Rust check, or package build failure stops that platform.
- A missing expected artifact stops release publication.
- Duplicate release asset names stop release publication.
- No job publishes a partial "latest" release.
- Re-running the same tag updates the existing draft instead of creating
  competing releases.
- Release upload uses the repository-scoped GitHub token. No long-lived token
  is stored in the repository.

## Verification

Before the tag is pushed:

- Validate Docker Compose configuration.
- Build and test the Linux image through Docker Compose.
- Verify the Linux artifact types and checksums.
- Run repository privacy and secret scans over the complete diff.
- Run `git diff --check`.

In GitHub Actions:

- Run frontend tests and the production frontend build.
- Run Rust tests and `cargo check`.
- Build every target bundle.
- Verify the final artifact inventory and SHA-256 file.
- Confirm the release is attached to the exact `v0.1.0` tag and commit.

After publication:

- Download every release asset through GitHub.
- Verify every checksum from `SHA256SUMS.txt`.
- Confirm the release is public and marked as the latest release.

Native launch smoke tests on Windows and both macOS architectures are outside
the container-only build scope. The workflow verifies compilation and
packaging; later signed releases should add native launch and signing checks.

## Documentation

`README.md` will document:

- one-command Linux Docker builds;
- the Windows Docker-host requirement;
- why macOS uses GitHub's native runners;
- how to trigger a tagged release;
- unsigned-release warnings and checksum verification.

The release notes will name the supported architectures, package formats,
unsigned status, and checksum command.
