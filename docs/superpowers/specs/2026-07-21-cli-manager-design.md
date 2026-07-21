# CLI Manager — Design Spec

**Date:** 2026-07-21
**Status:** Approved (design), spec pending user review

## Problem

Running many AI CLI TUIs (Claude Code, Codex, Copilot CLI, opencode) across many
directories means a reboot or app close loses everything. Restoring 10 sessions
by hand — remembering which CLI, which directory, which conversation — is slow
and error-prone.

## Goal

A cross-platform desktop app hosting managed terminal sessions for AI CLIs,
where **every session's identity (CLI, working directory, CLI session ID) is
persisted the moment it launches**, so after an app restart or OS reboot each
session resumes with one click.

**Must-have:** click-to-resume after restart/reboot.
**v1 extras:** launch presets; finished-response alerts with sidebar priority.
**Supported CLIs:** claude, codex, copilot, opencode.

## Architecture

**Tauri v2** — single Rust binary + webview UI. Cross-platform: macOS, Windows,
Linux.

- **Rust core:** PTY spawning and I/O (`portable-pty`), session registry
  (persisted to disk), per-CLI adapters, settings, launch presets.
- **Frontend:** TypeScript, React + Vite, xterm.js (WebGL renderer) for
  terminal rendering; sidebar/tab UI.
- **Transport:** PTY output → frontend via Tauri events; keystrokes/resize →
  Rust via Tauri commands.

## Data model

Session record, written to disk synchronously on create and on every change
(crash-safe):

```
Session {
  id: Uuid,                // app-internal
  name: String,            // user-editable, defaults to dir basename + CLI
  cli: Claude | Codex | Copilot | Opencode,
  cwd: PathBuf,
  cli_session_id: Option<String>,  // the resume key
  group: Option<String>,   // sidebar grouping; defaults to project dir
  status: Running | Resumable | Error,
  extra_args: Vec<String>, // e.g. --model
  created_at / last_active: timestamps,
}
```

Registry + presets + settings stored in the platform app-data dir
(`tauri::api::path::app_data_dir`), JSON files.

```
Preset {
  name: String,
  cli: CliKind,
  cwd: PathBuf,
  extra_args: Vec<String>,
  group: Option<String>,
}
```

## CLI adapters (core feature)

Each adapter implements: `launch(session) -> Command`,
`resume(session) -> Command`, and (where needed)
`discover_session_id(session) -> Option<String>`.

| CLI | Launch / ID capture | Resume |
|---|---|---|
| claude | Pre-assign: generate UUID, `claude --session-id <uuid>` | `claude --resume <uuid>` |
| copilot | Pre-assign: `copilot --resume <fresh-uuid>` (creates session with that UUID) | `copilot --resume <uuid>` |
| codex | Discover: after launch, scan `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for a new file created ≥ launch time whose metadata cwd matches; extract UUID | `codex resume <uuid>` |
| opencode | Discover: query `~/.local/share/opencode/opencode.db` (sqlite, read-only) for newest session in that directory created ≥ launch time | `opencode --session <id>` run in cwd |

Discovery rules:
- Run in background after launch; retry with backoff for up to ~60s, then
  retry lazily (on user input / periodic tick) until found.
- Adapters verify flag behavior at runtime cheaply where possible; store
  layouts are treated as version-fragile and covered by fixture tests.

Fallback: if `cli_session_id` is still null at resume time, launch the CLI's
built-in resume picker (`codex resume`, `claude --resume` with no arg, etc.)
in the session's cwd, so the user picks from the CLI's own list — degraded but
nothing is lost.

## Restart / reboot flow

1. App starts → load registry → all sessions listed in sidebar with grey
   "resumable" status.
2. User clicks a session (or its tab) → adapter builds the resume command →
   PTY spawned in the original cwd → status green.
3. No auto-resume in v1 (resume-all button is a later extra).

## Lifecycle (setting)

- **Default:** quitting the app terminates child PTYs; everything is
  resumable on next start.
- **Optional:** "Keep sessions running when window closes" — window close
  hides to tray; the Rust process and PTYs stay alive. Explicit Quit (and
  reboot) end processes; resume path covers recovery.

## UI

- **Left sidebar:** collapsible groups (default: by directory); rows show CLI
  icon, name, status dot (green running / grey resumable / red error).
  Rename, regroup, delete via context menu.
- **Top tab strip:** open (running) sessions for fast switching.
- **Main pane:** one full-size xterm terminal for the active session.
- **New session dialog:** pick a preset, or choose CLI + directory + optional
  args manually; option to save the combo as a preset.
- **Settings:** lifecycle toggle, theme basics, alert behavior (badge only /
  badge + OS notification).

## Finished-response alerts

When a background (non-focused) session's agent finishes responding, the user
should see it at a glance and find it first.

**Detection** (Rust core, per PTY):
- **Activity heuristic:** track output volume per session. A burst of output
  followed by ≥ N seconds of silence (default 3s, tunable) while the session
  is not focused → mark `needs_attention`. This is CLI-agnostic and catches
  "response finished" as well as "waiting at a prompt".
- **Bell/OSC signals:** additionally listen for BEL (0x07) and OSC 9 /
  OSC 777 notification sequences in the PTY stream — Claude Code and other
  TUIs emit a terminal bell when a turn completes or input is needed. A bell
  from an unfocused session marks `needs_attention` immediately.

**Presentation:**
- Sidebar row gets an alert dot/badge; sessions with `needs_attention` sort
  to the top of their group (priority), with a subtle highlight.
- Tab strip shows the same badge on the session's tab.
- App icon shows a count badge (dock/taskbar) of sessions needing attention;
  optional OS notification per settings.
- Focusing the session clears its `needs_attention` flag.

`needs_attention` is runtime-only state — not persisted; after an app restart
all sessions are simply "resumable".

## Error handling

- CLI binary not on PATH → inline message with install hint; session saved
  anyway.
- Resume rejected (session deleted/expired CLI-side) → offer fresh session in
  same cwd (keep record, clear `cli_session_id`).
- PTY exits unexpectedly → red status + exit code; one-click relaunch
  (resume).
- Discovery timeout → session still usable; resume uses picker fallback.
- Registry write failure → surfaced in UI immediately (persistence is the
  core promise).

## Testing

- **Rust unit tests:** adapter command construction; codex jsonl and opencode
  sqlite discovery against fixture files copied from real store layouts.
- **Integration tests:** spawn fake CLI scripts that mimic session-file
  creation; verify capture → kill → resume command round-trip.
- **Manual E2E:** one pass per real CLI: launch → converse → quit app →
  relaunch → resume → verify conversation history present.

## Out of scope (v1)

Resume-all button, split/grid terminal view,
remote/SSH sessions, session search, non-AI arbitrary shells (may work
incidentally, not a target).
