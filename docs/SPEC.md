# Anchor — Product & Technical Specification

**Status:** Approved. This document is the single source of truth for the project.
**UI mock (authoritative frontend spec):** [`docs/Anchor.dc.html`](./Anchor.dc.html) — open it in a browser. **The application must be built to this mock.**
**Audience:** This spec is written so an AI or human with *zero* prior context can implement any phase of the project from this document alone.

> ⚠️ **This is a PUBLIC repository. Never commit personal information** — no real API keys, tokens, usernames, machine-specific absolute paths, or private data of any kind. Example/fixture data must be synthetic.

---

## 1. Problem & Product

Developers run many AI coding CLIs at once — Claude Code, Codex, GitHub Copilot CLI, opencode — across many project directories. When the machine reboots or the terminal app closes, all of those sessions are lost, and manually restoring 10 sessions (which CLI? which directory? which conversation?) is slow and error-prone.

**Anchor** is a cross-platform (macOS / Windows / Linux) desktop app that hosts managed terminal sessions for AI CLIs. Its **core promise**: every session's identity — CLI tool, working directory, and the CLI's own session ID — is persisted to disk *the moment the session launches*, so after an app restart or OS reboot every session can be resumed with one click, restored to its original directory and conversation. Resume always targets that persisted ID; Anchor never opens a provider's interactive session picker.

### Supported session types (5)

| key | Name | Badge | Kind |
|---|---|---|---|
| `claude` | Claude Code | `cc` | AI CLI |
| `codex` | Codex | `cx` | AI CLI |
| `copilot` | Copilot | `co` | AI CLI |
| `opencode` | opencode | `oc` | AI CLI |
| `terminal` | Generic terminal | `›_` | Plain shell (persistence = scrollback restore, not session ID) |

### Non-goals (v1)

Split/grid multi-terminal view, remote/SSH sessions, session content search, Windows-specific shell integrations beyond ConPTY basics, light theme (Anchor is dark-only per mock).

---

## 2. Architecture

**Tauri v2** desktop app:

- **Rust core ("backend")** — everything invisible: PTY spawning and I/O (`portable-pty` crate), the session/folder registry, per-CLI adapters (launch/resume/session-ID discovery), status detection, scrollback persistence, settings. *"Backend" here means the in-process Rust logic layer, not a server.*
- **Web frontend** — TypeScript + React + Vite. Terminal rendering with **xterm.js** (`@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl`). All UI per the mock.
- **IPC** — Tauri commands (frontend → Rust) and Tauri events (Rust → frontend). The complete contract is §6; it is the boundary that lets backend and frontend be built by different agents in parallel.

### Repository layout

```
anchor/
├── docs/
│   ├── SPEC.md              ← this file
│   └── Anchor.dc.html       ← authoritative UI mock
├── src/                     ← frontend (React + TS)
│   ├── main.tsx
│   ├── App.tsx
│   ├── ipc/
│   │   ├── types.ts         ← IPC contract types (§6) — mirror of Rust types
│   │   ├── commands.ts      ← typed invoke() wrappers
│   │   ├── events.ts        ← typed event subscriptions
│   │   └── mock.ts          ← in-browser mock IPC (dev without Rust, see §8 Phase 3)
│   └── ...components/state
├── src-tauri/               ← Rust core
│   ├── src/
│   │   ├── main.rs / lib.rs
│   │   ├── commands.rs      ← #[tauri::command] handlers (thin; delegate to modules)
│   │   ├── pty.rs           ← PTY spawn/read/write/resize/kill
│   │   ├── registry.rs      ← folders + sessions persistence
│   │   ├── adapters/        ← claude.rs, codex.rs, copilot.rs, opencode.rs, terminal.rs
│   │   ├── status.rs        ← running/waiting detection
│   │   ├── scrollback.rs    ← terminal scrollback save/restore
│   │   └── settings.rs
│   ├── tauri.conf.json
│   └── Cargo.toml
├── AGENTS.md / CLAUDE.md    ← agent instructions (public-repo rules)
└── package.json
```

---

## 3. On-disk data (Rust core owns all of it)

Root data directory: **`~/.anchor/`** by default (the "Backup location" setting, default `~/.anchor/sessions`, controls where the sessions registry lives; settings live in the platform config dir via `tauri-plugin`/`dirs`, but MAY also live in `~/.anchor/` — implementer's choice, documented in code).

| File | Contents |
|---|---|
| `~/.anchor/sessions/registry.json` | Canonical folders + sessions document (schema below). **Written synchronously on every mutation** (create/rename/status-relevant change/discovered session ID) by synchronized temporary file + atomic rename. |
| `~/.anchor/sessions/registry.last-good.json` | Checksummed recovery envelope for the newest committed registry. |
| `~/.anchor/sessions/backups/registry-v*-*.json` | Checksummed registry generations. The newest ten are retained; every schema migration preserves its exact source first. |
| `~/.anchor/sessions/recovery/registry.corrupt-*.json` | Diagnostic copies of malformed or invalid primaries preserved before automatic recovery. |
| `~/.anchor/sessions/scrollback/<session-uuid>.txt` | Raw terminal scrollback for `terminal`-type sessions (and optionally others). Pruned per the retention setting (days). |
| `settings.json` | User settings (schema §7), stored in the platform configuration directory outside the installed application. |
| `settings.last-good.json` | Checksummed recovery envelope for settings, including the path that locates the session registry. |

`registry.json` schema (serde JSON, camelCase):

```jsonc
{
  "version": 2,
  "folders": [
    {
      "id": "uuid",
      "name": "acme-web",          // display name, user-renamable
      "path": "~/dev/acme-web"     // absolute path (tilde-expanded at use)
    }
  ],
  "sessions": [
    {
      "id": "uuid",                 // Anchor-internal ID (stable forever)
      "folderId": "uuid",
      "tool": "claude|codex|copilot|opencode|terminal",
      "title": "refactor auth middleware",  // user-renamable; default "new <Tool> session" / shell name
      "cliSessionId": "…|null",     // THE resume key. null until known (codex/opencode discovery pending; terminal: null)
      "status": "stopped",          // persisted as stopped|<last known>; on app boot always normalized to "stopped"
      "model": "claude-sonnet-4-6|…|null",  // informational, shown in resume card; null if unknown
      "extraArgs": ["--model", "opus"],      // optional extra CLI args used at launch
      "codexProfile": "work|…|null",          // selected Codex profile name; null = base config, always null for other tools
      "createdAt": "ISO-8601",
      "lastActiveAt": "ISO-8601",
      "wasOpenInTab": true          // for auto-restore: reopen this tab on next boot
    }
  ]
}
```

**Durability and update contract:**

- Application installers and updates replace application files only. They must
  never put the registry, scrollback, settings, or recovery files inside the
  installed application bundle.
- Version 1 is a supported migration source. The version 2 loader snapshots the
  exact version 1 document, migrates it in memory, validates it, and atomically
  commits version 2 without changing folder IDs, Anchor session IDs, or
  `cliSessionId` values.
- Each committed registry also updates a SHA-256-protected last-good file and a
  generation. Recovery accepts a file only when its checksum and full registry
  validation pass.
- If a supported primary is malformed or invalid, Anchor preserves a diagnostic
  copy and restores the newest valid last-good or generation file. A missing
  primary also recovers when a valid recovery file exists.
- A registry from a newer unsupported Anchor version fails closed. An older app
  must not replace it with an older recovery generation.
- Future schema changes must keep an explicit reader for each migrated version,
  snapshot before migration, migrate in memory, validate, and atomically commit.
  Migration tests must prove every provider session ID stays byte-for-byte
  identical.
- Settings use the same atomic primary-write pattern and recover from their
  checksummed last-good file. Defaults apply only when neither a primary nor a
  recovery file exists.
- These safeguards cannot survive loss of the storage device. Users who need
  device-loss protection must place the configured backup directory on storage
  that is backed up independently.

Registry version 1 records remain supported. They load with `codexProfile: null`
and are rewritten as version 2 on the next registry mutation.

---

## 4. Session lifecycle & status model

**Exactly three statuses** (mock is authoritative, see the comment block in the mock source):

| status | Dot | Meaning |
|---|---|---|
| `running` | 🟢 `#5fb891` | Process ON; AI working or shell live. |
| `waiting` | 🟡 `#d4a35f` | Process ON but **blocked on user input** (approval prompt, `[y/N]`, question). This is the "needs your attention" state. |
| `stopped` | *no dot* | Process NOT running. May hold a saved `cliSessionId` → resumable. |

- ON = running ∨ waiting. OFF = stopped.
- **Tabs ↔ ON:** with the default setting `stopOnClose: true`, an open tab corresponds to an ON session; closing a tab stops the process. Sidebar dots therefore mirror open tabs exactly.
- Clicking a stopped session in the sidebar opens its tab showing the **Resume card** (not a live terminal). Pressing **Resume** relaunches the CLI with its resume flag → `running`.
- On app boot every session is normalized to `stopped` (no processes survive an app quit in v1; the "keep running in tray" lifecycle option is deferred — see §10 Future).

### Waiting/attention detection (Rust, `status.rs`)

A session flips `running → waiting` when any of:
1. **Bell/OSC:** BEL (0x07) or OSC 9 / OSC 777 notification sequence appears in PTY output while the session is ON. Emitted by Claude Code and others when a turn completes or input is needed.
2. **Idle-after-burst heuristic:** ≥ `waitingIdleMs` (default 3000 ms, tunable constant) of output silence immediately following an output burst. CLI-agnostic; catches "finished responding" and "sitting at a prompt".

Any subsequent PTY output or user keystroke flips `waiting → running`. Process exit → `stopped` (with exit code surfaced via event).

**Attention priority (spec addition on top of the mock):** within a folder, `waiting` sessions sort above others in the sidebar. The OS-level surface: dock/taskbar badge count of waiting sessions, and optional OS notification (settings toggle `notifyOnWaiting`, default off → badge only).

---

## 5. CLI adapters (the core feature)

Each adapter answers: how to **launch**, how to **capture the CLI's session ID**, how to **resume**. All spawns happen inside a PTY (`portable-pty`) with `cwd` = the session's folder path, size = current terminal cols/rows, and env = process env + user env vars from settings. If the effective `TERM` is absent or `dumb`, Anchor sets `TERM=xterm-256color`; the PTY is rendered by xterm.js and interactive CLI TUIs must not fall back to non-interactive mode.

**Executable resolution invariant:** detection, launch, and resume use the same resolver for every supported CLI and the configured terminal shell. It checks the effective configured `PATH` plus common per-user package-manager locations (including NVM installations), then passes the resolved absolute executable path to the PTY. The PTY prepends that executable's directory to the child `PATH`, so script launchers can find their matching sibling runtime (for example, NVM's `codex` finding NVM's `node`). Desktop-launch environment differences must not produce a false “CLI not installed” result or cause the PTY to perform a second, inconsistent lookup.

| tool | Launch command | Session-ID capture | Resume command |
|---|---|---|---|
| `claude` | `claude --session-id <uuid>` (Anchor generates the UUID) | **Pre-assigned** — known before spawn | `claude --resume <uuid>` once a Claude transcript exists; otherwise `claude --session-id <uuid>` reopens the same saved empty identity, never the picker |
| `copilot` | `copilot --session-id <uuid>` (Anchor generates the UUID) | **Pre-assigned** | `copilot --resume <uuid>` |
| `codex` | `codex [--profile <name>]` | **Discovered:** watch `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; a new file whose first-line JSON metadata has `cwd` == session folder and mtime ≥ launch time → extract its session UUID (in the filename and metadata) | Resume: `codex [--profile <name>] resume <uuid>`; explicit parallel recovery: `codex [--profile <name>] fork <uuid>` |
| `opencode` | `opencode` (run in cwd) | **Discovered:** read `~/.local/share/opencode/opencode.db` (SQLite, **read-only**, open with `immutable`/read-only flags to avoid locking): newest session row whose directory == folder path and created ≥ launch time. (macOS/Linux path shown; resolve per-platform data dir.) | `opencode --session <id>` run in cwd |
| `terminal` | user's default shell (settings `shell`, default `$SHELL` / platform default) | n/a — persistence = scrollback file | respawn shell in cwd; if `restoreScrollback` on, prepend saved scrollback to the xterm buffer with a `── restored session · scrollback recovered (N lines) ──` divider line (see mock) |

Discovery rules (codex/opencode):
- Background task starts at spawn and attempts discovery immediately, then polls with backoff (1s → 2s → 5s) for up to 60 s.
- The initial 60-second discovery window continues if the tab closes and stops the PTY, because the provider may finish writing session metadata after process shutdown. After that window, retry lazily every 30 s only while the session is ON.
- On success: write `cliSessionId` to registry immediately, emit `session:updated`.
- Extra args: `extraArgs` from the session record are appended to launch (not resume) commands.
- Model detection is best-effort (e.g. parse from output or store config); `model` may stay null.
- A Codex fork creates a new Anchor record before spawn, uses the source record's folder/profile/model but no launch-only `extraArgs`, and discovers/persists the fresh Codex UUID through the same bounded store watcher as a normal launch.

**Codex profiles:** Anchor discovers only the immediate `*.config.toml` filenames in
`$CODEX_HOME` (or `~/.codex` when unset), returning names only. It never reads or
exports profile TOML values because profiles can contain provider credentials.
Selected names use Codex's `--profile <name>` option and persist as
`codexProfile` on the Anchor session. A profile can change only while a Codex
session is stopped, so the current process never changes accounts mid-session.
Before launch or resume, the selected profile must still be present; otherwise
return `CODEX_PROFILE_NOT_FOUND` and do not fall back to the base config.

**Resume identity invariant:** every AI resume command must include the record's exact persisted `cliSessionId`. If an imported, corrupt, or undiscovered record has no ID, return `SESSION_ID_UNAVAILABLE` without spawning a process. Never launch a provider's interactive picker: manual selection can attach the Anchor record to the wrong conversation and defeats one-click resume. A fork is a separate, explicit user action that preserves the source transcript under a new provider ID; Anchor never substitutes it silently for Resume.

**Version fragility:** store layouts and flags above were verified 2026-07 against current CLI versions. Adapters must treat parsing failures as "discovery pending", never crash, and are covered by fixture tests (§9). A `detect_clis` command reports which CLIs are installed (`which`/`where` + `--version`).

---

## 6. IPC contract (the backend ↔ frontend boundary)

This section is normative. Backend implements exactly this; frontend consumes exactly this. TypeScript shapes below; Rust uses matching serde types with `#[serde(rename_all = "camelCase")]`. The scaffold checks in these types in `src/ipc/types.ts` and `src-tauri/src/` — **change them only by updating this spec first.**

### 6.1 Shared types

```ts
export type Tool = "claude" | "codex" | "copilot" | "opencode" | "terminal";
export type Status = "running" | "waiting" | "stopped";

export interface Folder { id: string; name: string; path: string; }

export interface Session {
  id: string;
  folderId: string;
  tool: Tool;
  title: string;
  cliSessionId: string | null;
  status: Status;
  model: string | null;
  extraArgs: string[];
  codexProfile: string | null; // selected Codex profile; null for base config and all non-Codex tools
  createdAt: string;      // ISO-8601
  lastActiveAt: string;   // ISO-8601
  wasOpenInTab: boolean;
}

export interface Settings {
  shell: string;                      // default shell for terminal sessions
  envVars: { key: string; value: string }[];  // extra env for all spawns; values masked in UI
  autoRestore: boolean;               // on boot: reopen wasOpenInTab tabs AND auto-resume them
  confirmClose: boolean;              // confirm before closing a running session's tab
  stopOnClose: boolean;               // closing a tab stops the process (default true)
  restoreScrollback: boolean;         // terminal sessions restore scrollback
  backupPath: string;                 // registry dir, default "~/.anchor/sessions"
  projectsDir: string;                // "Create a new project" target, default "~/Documents/Anchor/Projects"
  retentionDays: number;              // scrollback retention, 1–90, default 30
  theme: "graphite" | "obsidian" | "nebula";
  density: "comfortable" | "compact";
  fontSize: number;                   // terminal px, 11–18, default 13
  accent: string;                     // hex, default "#d6417a"
  notifyOnWaiting: boolean;           // OS notification when a session flips to waiting (default false)
}

export interface CliInfo { tool: Tool; found: boolean; version: string | null; path: string | null; }
export interface TerminalSize { cols: number; rows: number; }
export interface PtyResize { throughSequence: number; gridEpoch: number; }
export interface PtyReplay { data: string; throughSequence: number; cols: number; rows: number; coversUnsequenced: boolean; gridEpoch: number; }

```

### 6.2 Commands (frontend → Rust, via `invoke`)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_state` | — | `{ folders: Folder[]; sessions: Session[] }` | Full registry snapshot; called on boot. |
| `frontend_ready` | `{ cols: number; rows: number }` | `TerminalSize` | Called after event subscriptions, HYDRATE, and terminal viewport measurement; runs guarded one-time auto-restore at that initial PTY size on a blocking worker and resolves only after the serial restore pass completes. Returns the authoritative grid used by that pass. A caller that overlaps an existing pass receives its claimed grid; a later reload receives its own current grid. |
| `create_folder` | `{ path: string; name?: string }` | `Folder` | Name defaults to basename. Validates dir exists. |
| `create_project` | `{ name: string }` | `Folder` | Creates `<projectsDir>/<name>` then registers it. `name` must be a single path segment — separators, `.`/`..` and dotfiles are rejected so the write stays inside `projectsDir`. Errors: `PROJECT_NAME_INVALID`, `PROJECT_EXISTS`, `PROJECT_DIR_FAILED`. |
| `pick_folder` | — | `string \| null` | Opens the **OS folder picker** (Finder on macOS) via `tauri-plugin-dialog`; resolves to the chosen absolute path, or `null` if cancelled. Async + `spawn_blocking`: sync commands run on the main thread and the native dialog must be driven from there, so blocking on the main thread would deadlock. Errors: `DIALOG_FAILED`, `DIR_PATH_INVALID`. |
| `rename_folder` | `{ folderId: string; name: string }` | `Folder` | |
| `remove_folder` | `{ folderId: string }` | `void` | Stops + deletes all its sessions (UI shows the ack modal first). Async + `spawn_blocking`: it can wait on several PTY shutdowns. |
| `launch_session` | `{ folderId: string; tool: Tool; cols: number; rows: number; title?: string; extraArgs?: string[]; codexProfile?: string }` | `Session` | Creates record (persisted before spawn), spawns the PTY at the measured xterm size, and starts discovery. Status `running`. `codexProfile` is valid only for Codex. |
| `resume_session` | `{ sessionId: string; cols: number; rows: number }` | `Session` | Spawns the exact saved AI session by `cliSessionId`, or shell+scrollback for `terminal`, at the measured xterm size. Missing AI IDs return `SESSION_ID_UNAVAILABLE`; provider pickers are never opened. On Windows, Codex rollout sharing is checked before spawn and an existing writer returns `CODEX_ACTIVE_WRITER` without opening a fallback TUI. |
| `fork_codex_session` | `{ sessionId: string; cols: number; rows: number }` | `Session` | Creates and persists a new Anchor record, then runs `codex fork <sourceCliSessionId>` at the measured xterm size and discovers the fork's new ID. The source must be a stopped Codex record with a saved ID. No picker and no automatic resume fallback. |
| `get_codex_profiles` | — | `string[]` | Safe profile names only; immediate `$CODEX_HOME/*.config.toml` files. Never returns profile file contents or paths. |
| `set_codex_profile` | `{ sessionId: string; codexProfile: string \| null }` | `Session` | Persists the selected profile for future Codex launch/resume; `null` selects base config. Requires a stopped Codex session. Errors: `CODEX_PROFILE_CHANGE_REQUIRES_STOPPED`, `CODEX_PROFILE_NOT_FOUND`, `CODEX_PROFILE_INVALID`, `CODEX_PROFILE_UNSUPPORTED`. |
| `stop_session` | `{ sessionId: string }` | `void` | Graceful kill (SIGTERM → SIGKILL after 5 s; ConPTY close on Windows). Async + `spawn_blocking` so the graceful wait never blocks the native UI thread. |
| `delete_session` | `{ sessionId: string }` | `void` | Stops if ON; removes record + scrollback file. If shutdown reports a late completion error after the PTY is confirmed dead, deletion still completes. If the PTY remains live after the first shutdown error, Anchor retries shutdown once so one Delete action can finish an in-progress ConPTY teardown. Async + `spawn_blocking`. |
| `rename_session` | `{ sessionId: string; title: string }` | `Session` | |
| `set_tab_open` | `{ sessionId: string; open: boolean }` | `void` | Frontend reports tab open/close so `wasOpenInTab` persists for auto-restore. The sole close lifecycle command: with `stopOnClose` it also stops the PTY, so the frontend must not additionally call `stop_session`. Async + `spawn_blocking`. |
| `write_pty` | `{ sessionId: string; data: string }` | `void` | Keystrokes (UTF-8). |
| `resize_pty` | `{ sessionId: string; cols: number; rows: number }` | `PtyResize` | Returns the old-grid output boundary and the accepted grid epoch so xterm changes grids without parsing in-flight output at the wrong width. |
| `replay_output` | `{ sessionId: string }` | `PtyReplay` | Returns one authoritative live snapshot, the last live-output sequence included in it, the current PTY character grid, and whether saved unsequenced output is covered. With scrollback restore enabled, live generic terminals return their formatted persisted scrollback, set `coversUnsequenced`, and include its atomic persisted sequence boundary; other sessions return bounded recent PTY output. Zero dimensions identify a session with no live PTY. |
| `get_scrollback` | `{ sessionId: string }` | `string` | Saved scrollback (empty string if none). |
| `get_settings` | — | `Settings` | |
| `set_settings` | `{ settings: Settings }` | `Settings` | Full-object write. |
| `detect_clis` | — | `CliInfo[]` | |
| `export_sessions` | `{ toPath: string }` | `void` | Copies registry JSON (Settings › Export). |
| `import_sessions` | `{ fromPath: string }` | `{ folders; sessions }` | Merge by id; returns new state. |

Errors: commands reject with a string error code + message, e.g. `"CLI_NOT_FOUND: codex is not installed"`, `"RESUME_REJECTED: session no longer exists in claude's store"`, `"DIR_NOT_FOUND: …"`. Frontend surfaces them as toasts / inline states (§8).

### 6.3 Events (Rust → frontend, via `emit`)

| Event | Payload | When |
|---|---|---|
| `pty:output` | `{ sessionId: string; data: string; sequence: number; gridEpoch: number; cols: number; rows: number }` | PTY produced output (UTF-8; lossy-decoded). `sequence` increases per PTY generation. The grid fields identify the exact PTY grid that produced the batch. `gridEpoch` changes after each effective PTY resize. Batched ≤ every 16 ms per session. |
| `session:status` | `{ sessionId: string; status: Status; exitCode: number \| null }` | Any status transition (incl. exit → `stopped`). |
| `session:updated` | `Session` | Record changed outside a command's return (e.g. `cliSessionId` discovered). |
| `session:resume-error` | `{ sessionId: string; code: string; message: string }` | A provider rejected a resume after PTY spawn. Anchor emits a sanitized actionable error, stops the unusable PTY, and keeps the saved source identity unchanged. |
| `attention:count` | `{ waiting: number }` | Waiting-count changed (backend also sets dock/taskbar badge + optional OS notification itself). |

---

## 7. Settings surface (per mock, Settings view sections)

- The Settings navigation shows the packaged Anchor version so users can identify the installed build.
- **General:** Default shell (text input; on Windows, new and legacy-default settings prefer `pwsh.exe`, the current PowerShell host, when installed and otherwise use `powershell.exe`); Environment variables (key/value list, values masked, stored locally only — **never committed anywhere**); toggles: Auto-restore sessions on launch, Confirm before closing a running session, Stop session when its tab is closed, Notify when a session needs attention (`notifyOnWaiting`). Every persisted setting must have a control here: the badge-only default is a choice the user makes, not one the absence of a toggle makes for them.
- **Persistence & Backup:** persisted-session count callout; Backup location (path input + Browse); Save & restore terminal scrollback toggle; Scrollback retention slider (1–90 days); Export sessions… / Import… buttons.
- **Appearance:** Theme radio (Graphite / Obsidian / Nebula — all dark; they vary background tint); Accent color swatches; Density radio (Comfortable / Compact); Terminal font size slider (11–18 px) with live preview line.
- **Keyboard Shortcuts:** read-only list: ⌘K command palette · ⌘, settings · ⌘W close tab · ⌃⇥ next/prev tab · ⌘↩ resume session under cursor · ⌘T new generic terminal · ⌘F focus filter. (Ctrl on Windows/Linux.)

---

## 8. Frontend spec

**The mock `docs/Anchor.dc.html` is the authoritative UI spec** — layout, spacing, colors, typography, interactions, empty states, menus, modals, and copy must match it. Open it in a browser to see live behavior (it is a self-contained interactive prototype; its inline JS shows exact intended interaction logic, including the status model comment block). Key inventory:

- **Window chrome bar** (38 px): app mark + "Anchor", centered active folder path (JetBrains Mono), traffic-light placeholders (use native window controls per-platform; overlay/hidden-title-bar style).
- **Sidebar** (298 px): filter input with ⌘K chip; folder groups — enlarged clickable name for collapse (renamable inline), session count, no visible folder path or collapse marker, hover `⋯` menu (Rename group / Copy folder path / Remove group → ack-checkbox modal), `+` quick-launch menu (the 4 AI CLIs + Generic terminal, "Launch in <folder>"); indented session rows — tool badge, title (renamable inline), status dot, hover actions (✕ delete with confirm popover: "Delete this session? Its saved session ID will be removed.", `⋯` menu: Rename session / Copy session ID); right-clicking a session row opens that same `⋯` menu; footer — running/waiting/stopped counts + Settings button.
- **Tab strip:** open sessions, badge + title + dot + ×, `+` opens the New-session wizard.
- **New-session wizard** (three steps). Opening from a folder's quick-launch `+`
  jumps straight to `tool`; opening from the tab strip or ⌘O starts at `folder`,
  so a cold start with no folders is recoverable:
  1. **folder** — "Folders already in Anchor" (name, path, session count) plus
     "Add a folder": *Choose an existing folder…* (⌘O) and *Create a new project*.
  2. **create** — project name input, live "will be created at
     `<projectsDir>/<name>`" preview, Create disabled until non-empty.
  3. **tool** — the chosen folder with a Change button, then the five CLIs.

  *Choose an existing folder…* calls `pick_folder`, which opens the **native OS
  folder picker** rather than an in-app browser. Cancelling leaves the wizard on
  the folder step. If the returned path is already registered, that folder is
  reused instead of being added twice.
  (The mock draws an in-app browser for this step; the native picker was chosen
  deliberately over it — less code and the dialog users already know.)
- **Main pane:** live terminal (xterm.js, JetBrains Mono, `fontSize` setting) for ON sessions; **Resume card** for stopped ones — badge, title, folder path, "Saved session — ready to resume" panel (session id / model / last active), gradient "↻ Resume session" button, "Restored from <backupPath>" footnote; empty state when no tabs ("No session open · Press ⌘K …").
- **Status bar:** active session badge/title/tool·model, session-id chip with copy, status chip, Stop button (only when `stopOnClose` is off and session is ON), right side: counts + shortcut hints.
- **Command palette (⌘K):** fuzzy filter over sessions (title, folder, tool); Enter jumps/opens tab.
- **Toasts:** "Session ID copied" / "Folder path copied" style, bottom-center.
- **Theming:** dark-only; accent gradient `--acc2 → --acc` (defaults `#8a3fd0 → #d6417a`); glass blur; design tokens exactly as the mock's CSS vars. Badges/colors per tool as in mock (`cc` orange, `cx` green, `co` blue, `oc` purple, `›_` neutral).
- **Sorting (spec addition):** session rows are ordered by **user activity**
  within their folder. Typing into a session's terminal moves it to the top of
  its folder; the next most recently typed-in session follows, and so on.
  Sessions the user has never typed into keep registry order below those.

  Ordering must not depend on `status`. The idle detector flips ON sessions
  between `running` and `waiting` every few seconds (§4), so ranking by status
  made rows reshuffle on their own while the user was reading them. Selecting a
  row or a tab does not reorder it either — only keystrokes do, taken from
  xterm's `onData`, which never fires for PTY output. Attention is conveyed by
  the status dot rather than by position.

Frontend architecture requirements:
- **Custom, extensible component library:** all UI is built from an in-repo
  component library at `src/components/lib/` — no external UI kit (no MUI,
  shadcn, Radix, etc.). Requirements:
  - Primitives derived from the mock's recurring patterns — at minimum:
    `GlassPanel`, `Button` (incl. gradient variant), `IconButton`, `Badge`
    (tool badge), `StatusDot`, `Toggle`, `RadioGroup`, `Slider`, `TextInput`,
    `Menu`/`MenuItem` (the `⋯`/`+` popovers), `Modal`, `ConfirmPopover`,
    `Toast`, `Tab`, `SidebarRow`, `Tooltip`.
  - Styled exclusively via design tokens (`src/components/lib/tokens.ts` +
    CSS variables) extracted from the mock — accent/gradient, glass blur,
    surface alphas, radii, typography, status colors — so theme/accent/density
    settings flow through tokens, not per-component overrides.
  - Extensible by construction: variants via props, `className`/style
    pass-through, composition over configuration; components are app-agnostic
    (no IPC imports, no session/folder domain types) so new screens and future
    features can reuse them.
  - Each component documented with a short usage comment; a simple gallery
    route/page (dev-only) rendering every component in all variants for visual
    review.
- Typed IPC layer (`src/ipc/`) is the *only* place `invoke`/`listen` appear.
- **`src/ipc/mock.ts`:** a browser-only mock implementation of the same interface (seeded with data resembling the mock's sample state, simulated status changes) selected via `VITE_IPC=mock` env — so the frontend agent can build & demo the entire UI in a plain browser without the Rust side, and the real backend drops in without UI changes.
- One xterm.js `Terminal` instance per ON session, kept alive while its tab
  exists (switching tabs must not lose buffer).

  Each open ON session owns one stable xterm DOM slot for the tab's lifetime.
  Changing `activeId` changes visibility only; it never reparents another
  session's xterm root. Exactly one slot is visible. Before the viewport is
  measured, PTY output stays as raw per-session chunks; Anchor creates or
  resizes that session's xterm to the measured grid before parsing the chunks.

  The deck keeps one hidden, non-interactive xterm measurement surface in the
  same box and with the same layout-affecting xterm options as every session
  slot. Launch, resume, and auto-restore apply the saved font, wait for its
  measured cols/rows, and pass that size into the initial PTY spawn, so a CLI
  never draws its first frame at xterm's 80×24 default. A detached measurement
  surface is never accepted: operations started from Settings return to the
  terminal view and wait for a fresh measurement. Every resumed PTY is a new
  terminal generation: Anchor resets the retained xterm screen and parser state
  after spawn success, then flushes output held during that preparation; generic
  terminals restore saved scrollback exactly once. If resume fails, the held
  output is discarded and the previous screen remains visible. Anchor allows
  only one in-flight resume per session;
  repeated keyboard or pointer activation does not replace its preparation.
  Manual resume waits for any stopped-generation resize and both xterm parser
  phases before it changes the grid or reset state. Closing or permanently
  removing the session cancels a resume waiting at that boundary. Reopening a
  tab can still complete a resume whose backend spawn is already in flight.
  Tab-open persistence writes are serialized per session, so the newest open or
  close intent is also the final durable state.

  `fit` addon measurement on resize → `resize_pty`. Measurement does not resize
  xterm. The core returns the last old-grid output sequence and the accepted
  `gridEpoch`; the frontend buffers the transaction, parses every sequence
  through that boundary at the old grid, then resizes xterm and releases
  new-epoch output. The reader stamps bytes with their grid before the batching
  channel. Resize cancels and joins an in-progress blocking pipe read before it
  advances the epoch, so bytes already consumed cannot be labeled with the new
  grid. A successful resize flushes that old-grid batch into its returned
  boundary, while a failed resize leaves it pending. Sequence assignment through
  callback delivery is serialized per PTY, and resize does not return until its
  claimed old-grid event is delivered; neither newer output nor exit publication
  can overtake that final batch. Each output event also carries its exact cols/rows, so an
  epoch transition that crosses the independent command/event queues can apply
  the producing PTY grid without guessing. Fitting forces layout, so mount and
  every `ResizeObserver` callback are coalesced into one animation frame, and
  only dimensions not already confirmed or queued reach `resize_pty`. Resize
  calls are serialized per session and coalesce to the newest measured size.
  A rejected resize retries twice without requiring another layout event, then
  reports the persistent error. Auto-restore uses the grid claimed by the first
  readiness handshake. A replacement webview keeps restore output raw and uses
  each replay's backend-authoritative live PTY grid before applying its
  snapshot, even when the replacement arrives at the restore boundary.
  Font-size changes use this same resize path.

  Every open ON session is fitted, not only the selected one. A background
  session keeps printing, and its CLI wraps that output to whatever width the
  PTY reports, so leaving an unselected terminal at xterm's default 80×24 while
  its pane is far wider renders it mangled until a window resize reflows it.
  Slots are laid out identically, so a hidden slot measures the box the user
  will see. Focus follows selection only: refitting a hidden slot must never
  move the caret out of the visible terminal.

  Terminal clipboard shortcuts follow desktop conventions. `Ctrl+C`/`Cmd+C`
  copies selected xterm text and sends an interrupt only when no text is
  selected. `Ctrl+V`/`Cmd+V` produces xterm's text paste event for text. When a
  paste event contains an image, Anchor forwards the CLI image-paste key so AI
  tools can read the image from the operating-system clipboard.

- Frontend event listeners are installed before the initial `get_state` request.
  Session status and identity events received while boot data is loading are
  folded into that snapshot before `HYDRATE`; an older state read never
  overwrites a newer live event.
  After hydration and terminal viewport measurement, the frontend sends
  `frontend_ready` with cols/rows, which triggers one-time
  auto-restore. Restored PTY output and status therefore cannot race listener
  registration or be overwritten by the pre-restore snapshot.

- The core, not the webview, owns live session output. Every live PTY retains
  its recent output (capped, trimmed at line boundaries), because a webview
  reload — dev HMR, ⌘R, window recreation — destroys every xterm buffer while
  the processes keep running. On boot the frontend buffers subscribed live
  events and calls `replay_output` once per session that is already ON. The
  returned snapshot includes a sequence boundary, PTY grid, and `gridEpoch` assigned under
  the same ordering lock as live output and resize. The frontend sizes xterm to
  that grid, writes the snapshot, drops buffered or delayed
  events at or below that boundary, then appends newer events. Each chunk
  appears once even when output arrives during boot. If the bounded frontend
  capture drops an event newer than the returned boundary, it requests a newer
  snapshot instead of applying output with a sequence gap. Retained runtime
  bytes always belong to one grid: a resize keeps the old snapshot and its old
  grid until new output arrives, then starts a fresh buffer at the new grid.
  If output captured during replay belongs to a newer grid epoch, the hidden
  xterm is reset and Anchor requests a newer snapshot. The parser handoff is
  finite and capped; it never waits for a continuously printing PTY to become
  idle. Output captured during the final handoff is queued through one last
  parser callback before the live terminal can mount.
  A live generic terminal
  with scrollback restore enabled uses its persisted file as the snapshot and
  the last sequence committed to that same file as the boundary. The frontend
  never combines an independent scrollback read with recent PTY output, because
  those overlapping sources cannot define an atomic duplicate-free boundary.
  The frontend keeps restore output raw until `frontend_ready` completes, then
  re-reads the authoritative session states. Each replay supplies the live
  PTY's current grid; the frontend sizes that session's xterm to the replay grid
  before parsing its snapshot and waits for xterm's final asynchronous write
  callback before mounting or fitting live slots. The post-restore state replaces the hydrated
  session set, including removal of records deleted while boot was in flight.
  Every terminal replay owns the pre-generation saved transcript and sets
  `coversUnsequenced`. After a persistence failure, the backend freezes the
  exact saved-file byte boundary and keeps a bounded, generation-wide fallback
  for later output across grid epochs; it never combines that prefix with the
  epoch-local runtime replay. Delayed sequence-zero events are then safe to drop
  as duplicates.
  Launch and Resume remain blocked until this boot replay phase and
  `frontend_ready` handshake complete, so a new PTY generation cannot cross a
  stale boot snapshot. Output held for a prepared resume is lossless and separate from the
  bounded live boot capture; success flushes it and failure discards it.

- `set_tab_open(false)` is the sole close lifecycle command. When `stopOnClose`
  is enabled, the backend stops the PTY and persists the closed-tab state; the
  frontend must not also call `stop_session`. PTY waiting occurs on a blocking
  worker and never on the native UI thread. The tab is removed and its neighbour
  selected immediately; the terminal handle is released only once the close
  request succeeds, and not at all if the tab was reopened while it was in
  flight.

- When `confirmClose` is enabled and the session is ON, closing asks first and
  issues no lifecycle command until the user answers. The gate belongs to the
  close action itself, not to the tab strip, so every entry point — the tab's
  close button and ⌘W — is guarded by one decision. Confirming closes on the
  same immediate path above; dismissing leaves the session untouched. Sessions
  that are not ON never prompt, because closing their tab stops nothing.

---

## 9. Error handling & testing

**Errors (all surfaced in-UI, never silent):**
- CLI not installed → inline message in the terminal pane with install hint (`detect_clis`).
- Resume rejected / CLI errors on resume → keep record and show an error state. A Codex `CODEX_ACTIVE_WRITER` conflict is rejected before PTY spawn when Windows exposes the rollout sharing violation; a post-spawn provider rejection is also stopped. Both paths offer **Fork conversation and continue**, which preserves the transcript under a new ID; retry remains available after the other writer closes. Other failures offer "Start fresh session in this folder".
- Discovery timeout → session works normally, but resume is blocked with `SESSION_ID_UNAVAILABLE` rather than opening a provider picker.
- PTY unexpected exit → `session:status` with exitCode; UI shows it on the Resume card.
- Registry write failure → blocking toast (persistence is the core promise).

**Testing:**
- Rust unit tests: adapter command construction; codex jsonl parsing + opencode sqlite query against **fixture files** checked into `src-tauri/tests/fixtures/` (synthetic data only); registry atomic-write round-trip; version 1 → 2 migration with exact `cliSessionId` preservation; corrupt/missing-primary recovery; checksum rejection; future-version refusal; ten-generation retention; settings-path recovery; status heuristic (bell, idle-after-burst).
- Rust integration test: spawn a fake CLI script that writes a fake session file → assert discovery → kill → assert resume command.
- Frontend: vitest component tests for sidebar/status logic against the mock IPC; type-level guarantee that `types.ts` matches command signatures.
- Manual E2E per real CLI before release: launch → converse → quit app → relaunch → resume → verify conversation intact.

---

## 10. Phases

Work is split across three phases, each executable by a different agent with only this spec + repo. **Order: Phase 1 → Phase 2 (backend) → Phase 3 (frontend).** (Frontend can technically start against `mock.ts`, but backend lands first.)

### Phase 1 — Scaffold ✅ (done in-repo)
Deliverables:
- Tauri v2 + React + TS + Vite project that **compiles and launches** showing a placeholder window.
- All dependencies wired: `portable-pty`, `serde`, `uuid`, `rusqlite (bundled)`, `dirs`, `notify` (Rust); `@xterm/xterm` + addons, React (frontend).
- The IPC contract checked in as code: `src/ipc/types.ts`, `src/ipc/commands.ts`, `src/ipc/events.ts`, `src/ipc/mock.ts` (compiling stubs), and Rust module skeletons (`commands.rs`, `pty.rs`, `registry.rs`, `adapters/*`, `status.rs`, `scrollback.rs`, `settings.rs`) with types + `todo!()`/stub bodies, all commands registered.
- `AGENTS.md` / `CLAUDE.md`, `.gitignore`, README.
- Acceptance: `npm run build` (tsc + vite) passes; `cargo check` passes in `src-tauri`.

### Phase 2 — Backend (Rust core)
Implement per §§3–6, 9: PTY manager; registry with atomic persistence; the five adapters incl. codex/opencode discovery; status detection incl. badge/notification; scrollback save/restore + retention pruning; settings; export/import; every command & event of §6 for real; unit + integration tests green.
Acceptance: `cargo test` green; manual smoke: `launch_session`(claude) → registry on disk contains pre-assigned `cliSessionId` before first output; kill app; `resume_session` relaunches the same conversation.
**Do not touch `src/` (frontend) except `src/ipc/types.ts` — and only with a matching spec update.**

### Phase 3 — Frontend
Implement §8 to the mock, wired to the §6 contract (real backend by default, `VITE_IPC=mock` for browser dev). **Build the custom extensible component library first** (§8 "Frontend architecture requirements" — tokens, primitives, gallery page), then compose all views/interactions/shortcuts/settings from it; xterm integration; waiting-first sorting; toasts; palette.
Acceptance: visual parity with the mock at 1440×900; every screen composed from the `src/components/lib/` library (no one-off styled elements where a primitive exists); gallery page renders all components; all interactions in §8 work against the real backend; `npm run build` + vitest green.
**Do not touch `src-tauri/` except to register nothing — backend is done; report contract gaps instead of hacking around them.**

### Cross-phase rules
- The §6 contract is law. Any change to it = update SPEC.md in the same commit and note it in the commit message.
- Public repo: synthetic data only, no personal info, ever (see AGENTS.md).
- Conventional commits (`feat:`, `fix:`, `chore:`…), small and scoped.

---

## 11. Future (explicitly deferred)

Keep-running-in-tray lifecycle option (window close ≠ process stop); resume-all button (superseded by the `autoRestore` setting); split/grid view; needs-attention rules per-CLI; session transcript search; Linux ARM packaging.
