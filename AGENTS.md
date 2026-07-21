# Agent instructions — Anchor

> ## ⚠️ THIS IS A PUBLIC REPOSITORY — NEVER COMMIT PERSONAL INFORMATION
>
> No real API keys, tokens, or secrets. No real usernames, emails, or
> machine-specific absolute paths (nothing like `/Users/<name>/…` or
> `C:\Users\<name>\…`). No contents of `~/.anchor/`, `~/.claude/`, `~/.codex/`,
> `~/.copilot/`, or opencode data — test fixtures must be **synthetic**.
> Check every diff before committing.

## Start here

1. Read **[`docs/SPEC.md`](docs/SPEC.md)** — the single source of truth. It is
   written to be implementable with zero conversation context.
2. Open **[`docs/Anchor.dc.html`](docs/Anchor.dc.html)** in a browser — the
   authoritative UI mock. The app must be built to this mock.
3. Find your phase in SPEC.md §10 (1 Scaffold ✅ · 2 Backend/Rust · 3 Frontend)
   and stay inside its file boundaries.

## Rules

- The IPC contract (SPEC.md §6) is law. Changing it requires updating SPEC.md
  in the same commit.
- Backend agents: don't touch `src/` (except `src/ipc/types.ts` with a spec
  update). Frontend agents: don't touch `src-tauri/`; report contract gaps
  instead of working around them.
- Conventional commits (`feat:`, `fix:`, `chore:` …), small and scoped.
- Verify before claiming done: `cargo check` / `cargo test` (backend),
  `npm run build` / vitest (frontend).
