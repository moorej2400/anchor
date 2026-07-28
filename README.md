# Anchor

Managed terminal sessions for AI CLIs — run many Claude Code / Codex / GitHub
Copilot CLI / opencode sessions across many directories, and **resume every one
of them with a click after an app restart or OS reboot**. Each session's
identity (tool, working directory, CLI session ID) is persisted the moment it
launches. Resume always targets that exact saved ID; Anchor never opens an AI
provider's interactive session picker. CLI detection and spawning share one
resolver, including common user-level install locations omitted by desktop app
launch environments.

> ⚠️ **Public repository — never commit personal information.**
> See [AGENTS.md](AGENTS.md).

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
