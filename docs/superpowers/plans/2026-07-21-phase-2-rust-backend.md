# Phase 2 Rust Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete Anchor Phase 2 Rust core defined by `docs/SPEC.md` sections 3-6 and 9 without changing the frontend IPC contract.

**Architecture:** A managed `Backend` state owns the persisted registry, settings store, scrollback store, and live PTY manager. Persistence and adapter discovery use dependency-injected paths so tests never read real user data; Tauri commands remain thin wrappers over backend methods, while PTY reader/wait threads emit the normative events and update persisted session state.

**Tech Stack:** Rust 2021, Tauri v2, `portable-pty`, `serde`/`serde_json`, `uuid`, `chrono`, `rusqlite`, `dirs`, Tauri notification plugin, and Rust unit/integration tests with synthetic temporary fixtures.

---

### Task 1: Persistence foundations

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/models.rs`, `src-tauri/src/registry.rs`, `src-tauri/src/settings.rs`, `src-tauri/src/scrollback.rs`

- [ ] Write failing tests for registry round-trip, boot status normalization, atomic replacement, merge-by-id, settings validation/round-trip, scrollback append/read/delete, retention pruning, and the required terminal restore divider with recovered-line count.
- [ ] Run the focused tests and confirm they fail because the skeleton methods are unimplemented.
- [ ] Implement path expansion, parent-directory creation, versioned JSON persistence, full-object settings persistence, and path-scoped scrollback storage.
- [ ] Run the focused tests and confirm they pass.

### Task 2: CLI adapters and discovery

**Files:** `src-tauri/src/adapters/mod.rs`, `src-tauri/src/adapters/*.rs`, `src-tauri/tests/adapters.rs`, `src-tauri/tests/fixtures/**`, `src-tauri/tests/fake_cli.rs`

- [ ] Write failing command-construction tests for all five adapters, including the no-provider-picker resume invariant and launch-only extra arguments.
- [ ] Write failing synthetic-fixture tests for Codex first-line JSON discovery and opencode read-only SQLite discovery, including malformed/missing-store pending behavior.
- [ ] Run focused adapter tests and confirm the expected failures.
- [ ] Implement launch/resume specs and dependency-injected discovery paths without reading real CLI stores in tests, including immediate discovery, the 1 s -> 2 s -> 5 s initial window that survives PTY stop, and 30 s lazy retries while ON.
- [ ] Add the §9 fake-CLI integration test: launch a synthetic CLI that writes a synthetic Codex session file, assert discovery, kill it, and assert the generated resume command.
- [ ] Run focused adapter tests and confirm they pass.

### Task 3: Status detector

**Files:** `src-tauri/src/status.rs`

- [ ] Write failing deterministic tests for BEL, OSC 9, OSC 777, idle-after-burst, output-after-waiting, and input-after-waiting transitions.
- [ ] Run the focused tests and confirm they fail for missing behavior.
- [ ] Implement a clock-injected detector with exactly the three normative statuses.
- [ ] Run the focused tests and confirm they pass.

### Task 4: PTY manager and runtime events

**Files:** `src-tauri/src/pty.rs`, `src-tauri/src/backend.rs`, `src-tauri/src/lib.rs`

- [ ] Write failing tests around PTY manager absent-session errors, a synthetic shell lifecycle, and graceful-stop behavior (SIGTERM followed by SIGKILL after 5 s; ConPTY close on Windows) where platform support permits.
- [ ] Implement spawn/write/resize/stop with `portable-pty`, environment injection, 16 ms output batching, scrollback append, status detector ticks, process-exit handling, and event callbacks.
- [ ] On terminal resume with `restoreScrollback`, emit the saved buffer plus the required restored-session divider and recovered-line count before any new PTY output.
- [ ] Implement backend orchestration that persists records before spawn, captures preassigned IDs before first output, starts discovery retries, updates status/attention count, and exposes snapshots.
- [ ] Register managed backend state at application setup and initialize notification support.
- [ ] Run the PTY/backend tests and confirm they pass.

### Task 5: IPC commands, import/export, and CLI detection

**Files:** `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] Write failing backend tests for every registry mutation, unknown identifiers, folder validation, CLI detection shape, export, merge import, synchronous status/discovery persistence, and registry/session-ID persistence before spawning or accepting first output.
- [ ] Replace every Phase 1 stub with a thin Tauri command delegating to managed backend state.
- [ ] Ensure errors use stable `CODE: message` strings and no environment-variable values are logged or included in errors.
- [ ] Emit all four normative events; update the main-window badge and send optional waiting notifications.
- [ ] Run all Rust tests and confirm they pass.

### Task 6: Phase acceptance verification

- [ ] Run `cargo fmt --check`, `cargo test`, and `cargo check`.
- [ ] Inspect the diff for secrets, usernames, machine-specific paths, and accidental frontend changes.
- [ ] Run the required manual Claude smoke: launch through `launch_session`, verify the registry contains the pre-assigned `cliSessionId` before first output, stop/kill the app process, and verify `resume_session` relaunches the same conversation. If the local Claude CLI or safe test account is unavailable, Phase 2 remains unverified rather than being claimed complete.
- [ ] Reconcile every Phase 2 deliverable in `docs/SPEC.md` section 10 against code and test evidence.
