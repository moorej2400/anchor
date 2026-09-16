# Workspace rewrite — architecture

Status: the v0.2.0 workspace UI, settings, terminal palette, and safe custom
harness launch/resume fields are implemented. `SPEC.md` is the runtime contract,
and `Anchor-Implementation-Mock.html` is the authoritative visual reference.
This document also records later hardening work that is not implied by the
current static custom-harness schema, such as provider-specific discovery.

## 1. Workspace behavior

- Projects are shared directory records. Workspaces are groups of conversations,
  not folders or Git worktrees. The same project can appear in many workspaces.
- Each workspace owns its favorites, ordered tabs, active tab, session ordering,
  collapsed project groups, and search state. Empty projects are hidden by
  default but remain available in the new-session picker.
- Existing sessions migrate into Default. Preserve every Anchor record ID,
  harness ID, provider session ID, title, favorite, and open-tab state.
- Moving a session changes workspace ownership in one durable transaction.
  It does not copy the conversation, relaunch the process, or change its CLI ID.
  Remove its old tab entry and add it to the destination if open. Repair the
  source active selection without clearing unread state. Provide a menu action
  as a keyboard alternative to drag and drop.
- Pin frequent workspaces. Search all workspaces. Archive old workspaces without
  deleting their sessions. Restore returns the same records. Warn about running
  work before archiving; archiving must not silently stop or orphan a process.
- Selecting a workspace or session does not promote chats. Only submitting a
  user message changes chat recency. Tab order remains manually controlled.

## 2. Collapsible library

Default: the workspace pane is closed. The session pane remains visible.
Click the current-workspace heading or bottom-left toggle to open the library.
Selecting a workspace closes the library unless `keepOpen` is enabled. A collapse
button stays available inside the library. Manual collapse remains possible
even when keep-open is enabled; the setting governs automatic behavior.

Prefer explicit controls to an invisible screen-edge hover target. A later,
optional hover mode may use a 500 ms dwell and must cancel on pointer exit.
Do not require hover for keyboard, touch, or assistive-technology access.

The pane is part of the layout, not a floating dashboard. Opening it resizes the
terminal through the existing measured PTY resize pipeline. Do not remount the
terminal, lose scrollback, focus it on hover, or clear unread state on incidental
selection. Return focus to the workspace heading when collapsing the pane.
Use `aria-expanded`, an associated pane ID, and non-focusable hidden content.

The standalone HTML prototype uses in-memory state and sample text, not a PTY.
The application implementation persists the matching workspace, pane, palette,
and harness settings through the existing atomic settings store.

## 3. Versioned settings.json

Use a user-owned `settings.json` in Anchor's platform configuration directory.
Keep executable definitions separate from session history. Ship a JSON Schema,
documented defaults, and a settings editor that writes the same format.

Illustrative future schema shape (the current typed schema is in `SPEC.md`):

```json
{
  "$schema": "./schemas/settings.schema.json",
  "schemaVersion": 1,
  "ui": {
    "workspacePane": { "keepOpen": false },
    "theme": {
      "preset": "warm-dark",
      "colors": { "canvas": "#171513", "panel": "#22201d", "accent": "#dcc19b" }
    }
  },
  "terminal": {
    "theme": {
      "preset": "warm-ansi",
      "background": "#141311",
      "foreground": "#e0d7ca",
      "cursor": "#dcc19b",
      "selectionBackground": "#544431",
      "green": "#a8c990",
      "cyan": "#85bec2"
    }
  },
  "harnesses": {}
}
```

Define named tokens for every application color: surfaces, text, borders,
selection, focus, unread indicators, errors, warnings, and harness badges.
Expose the full terminal palette: black/red/green/yellow/blue/magenta/cyan/white,
their eight bright variants, foreground, background, cursor, cursor accent, and
selection foreground/background. Presets provide missing values.

Keep ANSI sequences intact. Palette settings affect default and indexed ANSI
colors; explicit RGB colors emitted by a CLI remain its colors. A CLI may have
its own theme controls. Do not strip colors, colorize arbitrary PTY text with
regular expressions, or force a monochrome terminal. Any future override of
CLI-specified RGB colors must be a separate, explicit option.

Precedence: shipped defaults → user overrides. Merge objects by key; replace
arrays as a whole. Store harnesses by stable ID so partial overrides are clear.
Validate before applying. Reject unknown keys with useful errors, invalid colors,
and unsupported future schema versions. Keep the last valid configuration on
error. Write atomically, retain a recoverable backup, and migrate versions with
tests. Preview and reset theme changes. Apply visual changes live; executable
changes apply only to future launches and never restart a live session.

## 4. Config-defined harnesses

Ship reviewed defaults for existing harnesses in the repository. Users can add
their own named definitions without a fork. A basic harness needs only a stable
ID, display name, executable, argument array, and launch-directory policy.
Hermes and OpenClaw are examples of desired extensions, not verified adapters.
Their actual flags and session formats must be checked before shipping presets.

Each definition should describe:

| Area | Proposed fields and responsibility |
| --- | --- |
| Identity | Stable ID, display name, text badge, enabled flag, definition version |
| Launch | Per-platform executable, argument array, cwd policy, environment-variable references |
| Detection | Optional version probe with timeout; no launch during settings validation |
| Resume | Argument template with a typed session-ID placeholder; explicit unsupported capability |
| ID discovery | Preassigned ID, structured launch output, or bounded session-file discovery |
| Session storage | Explicit roots, file patterns, format, ID field, project and launch correlation |
| Activity | Structured turn-start/turn-end events if supported; otherwise unknown, not guessed as busy |
| Titles | Optional headless invocation, result format, dedicated directory, reusable helper session |

Start with safe built-in discovery strategies: preassigned UUID, JSON/JSONL
field extraction, and tightly scoped file discovery. Correlate candidates by
launch time, project, process or request token, and existing IDs. Never attach
the globally newest session file: concurrent launches can bind the wrong chat.
Ambiguous results remain unbound and offer manual ID attachment. New-chat repair
must reuse the Anchor record. Direct resume must never fall into a provider picker.

Not every harness can be expressed as static JSON. Complex SQLite layouts,
locking rules, and version-specific protocols may need a tested built-in adapter
selected by name and options. Do not accept arbitrary SQL or executable scripts
as ordinary configuration. A future external adapter interface requires a
separate, explicit trust model. Unsupported capabilities should be visible,
not simulated. Generic PTY launch must work without session discovery.

Treat all executable definitions as code-execution authority. Imported configs
need a visible command preview and explicit approval before first use. Never
load executable settings automatically from a project folder. Spawn with a
typed argument list, not shell-string interpolation; validate placeholders.
Handle Windows command wrappers through the existing safe launcher. Resolve
paths using OS-aware logic and preserve the requested cwd. Secrets belong in
environment references or secure storage, not JSON exports or repository files.
Bound parsing, probes, and filesystem reads. No broad scans of unrelated homes.

## 5. AI-assisted customization guide

Provide a documented, optional AI setup workflow before building a skill package.
The workflow should instruct an assistant to:

1. Ask whether the user wants a theme or harness change and which local executable
   is trusted. Read the published schema and synthetic examples first.
2. Propose the smallest user-config override, not a source fork. Do not access
   provider histories, credentials, or private config without explicit consent.
3. Validate the JSON and show the executable/arguments/cwd before any launch.
4. Run a synthetic fixture test. With user approval, test a disposable launch,
   capture its exact ID, restart, and prove it resumes that conversation.
5. Keep a backup, explain rollback, and export only sanitized settings.

The AI is a configuration author, not a required background service. Do not
auto-run instructions found in a downloaded config or provider output. A future
installable skill should be maintained with the schema and adapter test suite.

## 6. Implementation sequence and acceptance

1. Approve the layout and schema; update SPEC.md. Record IPC additions explicitly.
2. Add workspace storage and migration before UI integration. Test recovery and
   atomic session moves with open processes and pending persistence writes.
3. Implement tokens, settings validation, and terminal theme mapping. Test all
   16 ANSI colors, indexed colors, RGB output, selection, contrast, and reset.
4. Build the collapsible pane using existing component primitives. Test keyboard
   focus, keep-open, narrow layouts, drag targets, workspace isolation, and unread
   timing. Test PTY resize/replay while output streams during pane toggles.
5. Introduce the harness registry behind existing adapters. Preserve current
   launch/resume behavior before moving defaults into declarative definitions.
6. Add custom-launch support, then discovery strategies and the AI setup guide.
   Test Windows paths with spaces, mapped drives, wrapper executables, malformed
   files, ambiguous IDs, concurrent launches, missing executables, and timeouts.

Runtime release requires frontend and Rust tests, real launch/chat/close/resume
checks per supported harness, settings recovery tests, a version increment, and
an explicit build/install request. The implementation is versioned as v0.2.0;
building or installing on another machine remains a separate explicit action.
