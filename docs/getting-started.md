# Getting started

[Back to Anchor](../README.md)

## Install Anchor

Open the [latest release](https://github.com/moorej2400/anchor/releases/latest)
and choose the file for your computer.

| Computer | Download |
| --- | --- |
| Mac with Apple Silicon | `macos_aarch64.dmg` |
| Mac with Intel | `macos_x86_64.dmg` |
| Windows, 64-bit Intel or AMD | `windows_x86_64-setup.exe` |
| Linux, 64-bit Intel or AMD | `.AppImage`, `.deb`, or `.rpm` |

These are filename endings; the full filename includes the app version.
Open the installer or use your Linux package manager. On macOS, copy Anchor
to Applications. For an AppImage, allow the file to run as a program first.

Preview builds are not notarized on macOS and can show an unknown-publisher
notice on Windows. See the release notes for the build you download.

The README image shows the current source version. A published release can
have fewer features than the current source.

## Prepare your tools

Anchor runs Claude Code, Codex, GitHub Copilot CLI, OpenCode, and regular
terminals. Install the tools you need and complete their sign-in steps in a
terminal before using them in Anchor. A regular terminal needs no AI account.

Your assistant's normal account, provider, and usage limits still apply.
Anchor does not include an AI subscription.

## Start a session

1. Open Anchor and select **New session**.
2. Choose an existing folder, create a project, or select a project already listed.
3. Select your assistant or **Generic terminal**.
4. Work in the terminal that opens. Use the sidebar or tabs to switch sessions.

Use workspaces to keep separate sets of chats. Projects are shared between
workspaces, so you can use the same folder for different tasks.

## Return to your work

Select a saved chat in the sidebar. If it has stopped, use **Resume** to reopen
its saved conversation. The provider must have saved a conversation ID for AI
resume to work. Anchor shows a recovery option when that ID is missing.

Closing a tab keeps the saved chat in the sidebar. In **Settings → General**,
you can choose whether closing a tab also stops its process and whether Anchor
restores open tabs on launch.

## If a tool does not start

- Check that it starts in a normal terminal and that sign-in is complete.
- If Anchor says the tool is missing, check its installation and restart Anchor.
- For Codex, select the intended named profile when starting the session.
- Open **Settings → General** to check the default shell and environment settings.

See [Settings and custom tools](configuration.md) for more options.
