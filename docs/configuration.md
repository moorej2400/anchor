# Settings and custom tools

[Back to Anchor](../README.md) · [Getting started](getting-started.md)

Open **Settings** from the sidebar. Settings apply as you change them.

## Everyday settings

| Section | What you can change |
| --- | --- |
| General | Default shell, new-project location, tab restore, close behavior, workspace rail, and environment variables |
| Appearance | Dark theme, accent color, and interface density |
| Notifications | Notifications for completed responses and the delay before a response counts as read |
| Terminal | Text size and terminal colors |
| Persistence & backup | Storage location, terminal output restore, history limits, and session import or export |
| Keyboard shortcuts | Available keyboard commands |
| About | App version |

The saved terminal history limit applies to regular terminal sessions. AI
conversation history remains with each tool's own session store. Exporting
Anchor sessions does not replace a backup of those provider stores.

## Codex profiles

Anchor lists named Codex profiles found in `profiles/*.toml` under
`CODEX_HOME`, or `~/.codex` when that variable is unset. It reads the names
without reading profile contents.

If named profiles exist, the session chooser lists those profiles. With one
profile, there is one Codex choice. The base configuration appears only when
there are no named profiles.

To change a saved Codex session's profile, stop the session and use **Set Codex
profile** from its menu. A saved profile that is no longer available must be
changed before that session can resume.

Anchor passes the selected profile to the installed Codex CLI. Configure
models, providers, and authentication in Codex itself.

## Add another command-line tool

In **Settings → Harnesses**, select **Add custom harness**. A harness tells
Anchor how to start a tool.

1. Enter a name and an executable that is available on your computer.
2. Set the tool kind and how its conversation ID is provided.
3. Enter launch and resume arguments, with one argument on each line.
4. Enable the harness and save it. It then appears in the new-session chooser.

Arguments are passed directly to the executable. They are not a shell command.
The supported placeholders are:

| Placeholder | Value |
| --- | --- |
| `{projectPath}` | The selected project folder |
| `{sessionId}` | The saved provider conversation ID |
| `{dataDirectory}` | The harness's optional dedicated data directory |

Use **Attach manually** if the tool provides a conversation ID that you must
copy. Use **Preassign UUID** only when the tool accepts an ID generated before
launch. Use **No session ID** for tools that do not support conversation resume.

The [technical specification](SPEC.md) defines the full launch and persistence
behavior.
