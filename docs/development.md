# Development

[Back to Anchor](../README.md) · [Building releases](releases.md)

## Run from source

Use Node.js 24 or newer, stable Rust, and the
[Tauri v2 operating-system prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm ci
npm run tauri dev
```

Anchor uses Tauri v2 and Rust for the desktop core, React and TypeScript for
the interface, and xterm.js for terminals. The product behavior and IPC contract
are defined in [SPEC.md](SPEC.md).

## Browser preview

To run the interface with sample data and no Rust backend:

```sh
VITE_IPC=mock npm run dev
```

Open the local URL printed by Vite. The browser preview uses the same React
components, styles, icons, and terminal renderer as the desktop app. Only the
IPC backend is replaced with `src/ipc/mock.ts`. It simulates terminal output,
folder selection, tool detection, and other desktop operations; it does not
start real assistants or test native process behavior.

## Full standalone mock

[Anchor-Implementation-Mock.html](Anchor-Implementation-Mock.html) is generated
from `src/main.tsx` and the real frontend. It includes the application scripts
and styles, so it can be opened as a standalone HTML file.

```sh
npm run mock:build
npm run mock:check
```

Edit `src/`, then regenerate the file. Do not edit the generated HTML by hand.
The check command compares the complete generated file with the current
frontend and fails if they differ. The normal build also regenerates it.

The README image is a Chrome capture of this standalone mock with synthetic
data. It is stored at `docs/images/anchor-preview.jpg`. When the interface
changes, regenerate the mock, check its main screens, and replace the image
with a new capture. Do not use real account details or project data.

## Checks

```sh
npm run build
npm test
npm run test:mock
npm run test:release
cd src-tauri
cargo check
cargo test
```

For browser layout and interaction checks, see [End-to-end checks](../e2e/README.md).
The browser mock cannot verify native PTYs, operating-system integration, or
provider authentication; use the desktop app for those checks.

## Repository guide

- `src/`: React interface, shared styles, and browser mock IPC.
- `src-tauri/`: Rust desktop core, tool adapters, and session storage.
- `build/`: Standalone preview and release build tooling.
- `docs/`: User guides, implementation specification, and design records.
- `e2e/`: Browser checks and their documentation.

Keep public examples synthetic. Never commit API keys, private session data,
or machine-specific paths.
