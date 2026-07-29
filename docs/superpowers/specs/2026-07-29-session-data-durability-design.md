# Session Data Durability Design

**Status:** Approved on 2026-07-29

## Goal

Preserve every saved AI session identity across application upgrades, schema
migrations, interrupted writes, and recoverable file corruption.

## Guarantees and limits

Anchor stores user data outside the installed application bundle. Replacing or
updating the application must not remove or reset that data.

No local design can survive loss of the storage device. This design protects
against application updates, process crashes, partial writes, schema changes,
and corruption when at least one local recovery generation remains valid.

## Storage layout

The configured session data directory keeps:

```text
registry.json
registry.last-good.json
backups/
  registry-v1-<timestamp>-<unique-id>.json
  registry-v2-<timestamp>-<unique-id>.json
scrollback/
  <session-id>.txt
```

`registry.json` remains the canonical IPC-compatible registry document.
`registry.last-good.json` is a checksummed recovery envelope for the most
recent committed registry. The `backups/` directory keeps up to ten checksummed
generations, including a source snapshot before each schema migration.

The platform configuration directory keeps:

```text
settings.json
settings.last-good.json
```

The settings recovery file is checksummed because it contains the configured
path that locates the session registry.

## Registry writes

Every registry mutation is validated and serialized before it reaches disk.
Anchor writes and synchronizes a same-directory temporary file, atomically
replaces `registry.json`, then writes the checksummed last-good envelope.
Failure before the primary replacement leaves the previous registry intact.
A last-good write failure cannot make the committed primary appear to have
failed.

## Startup and recovery

Anchor reads the schema version before it selects a recovery path.

- A supported primary registry loads normally.
- A version 1 registry is snapshotted, migrated in memory to version 2,
  validated, and atomically committed without changing any session identity.
- A malformed or invalid primary registry is copied to a uniquely named
  diagnostic file and restored from the newest valid last-good or generation
  backup.
- A missing primary registry is restored when a valid backup exists; otherwise
  Anchor starts with an empty registry.
- A registry written by a newer unsupported Anchor version fails closed.
  Anchor does not replace it with an older backup.
- A backup is accepted only when its SHA-256 checksum and full registry
  validation both pass.

Recovery rewrites the primary atomically and keeps the source recovery file.

## Settings recovery

Settings use the same atomic primary-write pattern. Each successful save also
updates a checksummed last-good file. If `settings.json` is missing, malformed,
or invalid, Anchor restores the last valid settings so it can still find the
session data directory. If both files are unavailable or invalid, a missing
primary uses defaults and an invalid primary returns an error.

## Retention

Registry generations sort by their timestamp and unique suffix. Anchor retains
the newest ten valid or invalid generation files and removes older generations
only after a newer primary and last-good file are durable.

## Compatibility contract

The registry schema version is a durable data contract. Each future version
must:

1. keep a reader for every version it migrates;
2. snapshot the exact source document before migration;
3. migrate in memory;
4. validate session IDs, folder references, and paths;
5. atomically write the new primary and recovery envelope;
6. test that every `cliSessionId` remains byte-for-byte identical; and
7. reject newer unknown versions without modifying any file.

## Verification

Rust tests use real temporary directories and synthetic session records to
prove:

- version 1 upgrades to version 2 without changing the CLI session ID;
- a pre-migration generation remains readable;
- corrupt and missing primaries recover from checksummed data;
- a corrupt checksum is rejected;
- an unknown future version is not overwritten;
- generation retention is bounded;
- settings recover the registry location;
- interrupted primary writes preserve the last committed state; and
- normal export, import, launch, discovery, and exact-ID resume tests still
  pass.
