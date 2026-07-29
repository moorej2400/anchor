# Session Data Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add checksummed recovery generations and a tested schema migration path so application updates cannot silently discard saved AI session identities.

**Architecture:** Keep the existing atomic primary registry, add a checksummed last-good envelope and ten rotating generations, and route startup through a version-aware loader. Upgrade the current version 1 document to version 2 without changing its record shape, which creates a real migration path that preserves the original source and every provider session ID. Give settings an adjacent checksummed last-good file so Anchor can recover the path to the registry.

**Tech Stack:** Rust, serde/serde_json, SHA-256, tempfile, Tauri 2.

---

## File map

- Create `src-tauri/src/durable_file.rs`: atomic byte writes and SHA-256
  checksum helpers shared by registry and settings persistence.
- Modify `src-tauri/src/registry.rs`: version 1 reader, version 2 writer,
  recovery envelopes, generation retention, migration, and recovery tests.
- Modify `src-tauri/src/settings.rs`: checksummed last-good settings and
  recovery tests.
- Modify `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`: direct SHA-256
  dependency.
- Modify `docs/SPEC.md`: durable storage layout, recovery order, migration
  contract, and acceptance tests.
- Modify `README.md`: remove the public-repository warning requested by the
  user.

### Task 1: Define the failing registry durability tests

**Files:**
- Modify: `src-tauri/src/registry.rs`

- [ ] Add a test that writes a synthetic version 1 registry, loads it, and
  expects a version 2 primary, a checksummed version 1 generation, and the
  exact original `cliSessionId`.
- [ ] Add a test that corrupts `registry.json` after a valid save and expects
  recovery from `registry.last-good.json`.
- [ ] Add a test that corrupts the last-good checksum and expects recovery from
  the newest valid generation.
- [ ] Add a test that writes an unsupported future version and expects an error
  with byte-for-byte unchanged primary data.
- [ ] Add a test that creates more than ten generations and expects only the ten
  newest to remain.
- [ ] Run:

```bash
CARGO_TARGET_DIR=/private/tmp/anchor-session-backups cargo test registry::tests::
```

Expected: compilation or assertion failures because the recovery APIs and
version 2 migration do not exist.

### Task 2: Implement shared durable-file primitives

**Files:**
- Create: `src-tauri/src/durable_file.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

- [ ] Add `sha2 = "0.10"` as a direct dependency.
- [ ] Implement `sha256_hex(bytes)` with `Sha256`.
- [ ] Implement `atomic_write(path, bytes, error_prefix)` with a
  same-directory `NamedTempFile`, flush, file sync, atomic persist, and
  best-effort directory sync.
- [ ] Unit-test stable SHA-256 output and atomic replacement.
- [ ] Run the focused durable-file and registry tests.

Expected: durable-file tests pass; registry tests still fail at missing
recovery behavior.

### Task 3: Implement versioned registry generations and recovery

**Files:**
- Modify: `src-tauri/src/registry.rs`

- [ ] Add a recovery envelope with `formatVersion`, `createdAt`, `sha256`, and
  `registry`.
- [ ] Parse the version from raw JSON before deserializing records.
- [ ] Treat version 1 as a supported migration source and version 2 as current.
- [ ] Snapshot version 1 before migration, preserve all records unchanged,
  validate, and atomically commit version 2.
- [ ] After each successful primary save, atomically update the checksummed
  last-good envelope.
- [ ] On malformed or invalid supported primary data, preserve a diagnostic
  copy and restore the newest valid last-good or generation envelope.
- [ ] Reject future versions before recovery and leave the primary unchanged.
- [ ] Keep ten generation files after a durable primary and last-good commit.
- [ ] Run all registry tests and confirm the new tests pass.

### Task 4: Define and implement settings recovery

**Files:**
- Modify: `src-tauri/src/settings.rs`

- [ ] Add failing tests that save settings, corrupt or remove the primary, and
  expect recovery of the exact `backupPath`.
- [ ] Add a failing test that corrupts both primary and last-good data and
  expects the existing invalid-settings error.
- [ ] Implement a checksummed settings recovery envelope adjacent to
  `settings.json`.
- [ ] Restore the primary atomically from a valid envelope; use defaults only
  when neither primary nor recovery file exists.
- [ ] Run all settings tests and confirm they pass.

### Task 5: Document the contract and remove the README warning

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `README.md`

- [ ] Document version 2, last-good files, checksummed generations, migration
  snapshots, recovery order, future-version refusal, and external data
  location.
- [ ] Add the upgrade and corruption cases to the required Rust test matrix.
- [ ] Remove the public-repository warning block from the top of `README.md`.
- [ ] Run `git diff --check`.

### Task 6: Validate and publish

**Files:**
- Review all changed files.

- [ ] Run:

```bash
npm run build
npm test
npm run e2e
cd src-tauri
cargo fmt --check
CARGO_TARGET_DIR=/private/tmp/anchor-session-backups cargo check
CARGO_TARGET_DIR=/private/tmp/anchor-session-backups cargo test
CARGO_TARGET_DIR=/private/tmp/anchor-session-backups cargo clippy --lib -- -D warnings
```

- [ ] Run a public-repository scan over the full branch diff for personal paths,
  credentials, private keys, and local AI state.
- [ ] Confirm the changed-code comments preserve migration, recovery, and
  fail-closed rationale without narrating obvious mechanics.
- [ ] Commit with a conventional commit message.
- [ ] Push `codex/session-data-backups` and verify the local, upstream, and
  remote hashes match.
