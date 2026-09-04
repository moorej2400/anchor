/**
 * Typed command wrappers — the ONLY place `invoke` may appear in the frontend.
 * Contract: docs/SPEC.md §6.2.
 * Set VITE_IPC=mock to run against src/ipc/mock.ts in a plain browser.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppState, CliInfo, Folder, PtyReplay, PtyResize, Session, Settings, TerminalSize, Tool } from "./types";
import { mockInvoke } from "./mock";

const useMock = import.meta.env.VITE_IPC === "mock";

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return useMock ? mockInvoke<T>(cmd, args) : invoke<T>(cmd, args);
}

export const ipc = {
  getState: () => call<AppState>("get_state"),
  /** Sent after listeners, hydration, and terminal viewport measurement. */
  frontendReady: (size: TerminalSize) =>
    call<TerminalSize>("frontend_ready", { cols: size.cols, rows: size.rows }),

  createFolder: (path: string, name?: string) =>
    call<Folder>("create_folder", { path, name }),
  createProject: (name: string) => call<Folder>("create_project", { name }),
  /** Opens the OS folder picker. Resolves to null when the user cancels. */
  pickFolder: () => call<string | null>("pick_folder"),
  renameFolder: (folderId: string, name: string) =>
    call<Folder>("rename_folder", { folderId, name }),
  removeFolder: (folderId: string) => call<void>("remove_folder", { folderId }),

  launchSession: (
    folderId: string,
    tool: Tool,
    size: TerminalSize,
    title?: string,
    extraArgs?: string[],
    codexProfile?: string | null,
  ) => call<Session>("launch_session", {
    folderId,
    tool,
    cols: size.cols,
    rows: size.rows,
    title,
    extraArgs,
    codexProfile,
  }),
  resumeSession: (sessionId: string, size: TerminalSize) =>
    call<Session>("resume_session", { sessionId, cols: size.cols, rows: size.rows }),
  /** Starts a new provider chat inside an existing record that has no provider ID. */
  repairSessionIdentity: (sessionId: string, size: TerminalSize) =>
    call<Session>("repair_session_identity", { sessionId, cols: size.cols, rows: size.rows }),
  /** Forks a Codex transcript into a new persisted Anchor session. */
  forkCodexSession: (sessionId: string, size: TerminalSize) =>
    call<Session>("fork_codex_session", { sessionId, cols: size.cols, rows: size.rows }),
  stopSession: (sessionId: string) => call<void>("stop_session", { sessionId }),
  deleteSession: (sessionId: string) =>
    call<void>("delete_session", { sessionId }),
  renameSession: (sessionId: string, title: string) =>
    call<Session>("rename_session", { sessionId, title }),
  setSessionId: (sessionId: string, cliSessionId: string) =>
    call<Session>("set_session_id", { sessionId, cliSessionId }),
  /** Uses one hidden reusable provider chat to name a visible session. */
  generateSessionTitle: (sessionId: string, message: string) =>
    call<Session>("generate_session_title", { sessionId, message }),
  /** Persists the profile that a Codex record will use when it next starts. */
  setCodexProfile: (sessionId: string, codexProfile: string | null) =>
    call<Session>("set_codex_profile", { sessionId, codexProfile }),
  setTabOpen: (sessionId: string, open: boolean) =>
    call<void>("set_tab_open", { sessionId, open }),

  writePty: (sessionId: string, data: string) =>
    call<void>("write_pty", { sessionId, data }),
  resizePty: (sessionId: string, cols: number, rows: number) =>
    call<PtyResize>("resize_pty", { sessionId, cols, rows }),
  /** Read a live session's retained output and the sequence it includes. */
  replayOutput: (sessionId: string) => call<PtyReplay>("replay_output", { sessionId }),
  getScrollback: (sessionId: string) =>
    call<string>("get_scrollback", { sessionId }),

  getSettings: () => call<Settings>("get_settings"),
  setSettings: (settings: Settings) =>
    call<Settings>("set_settings", { settings }),

  detectClis: () => call<CliInfo[]>("detect_clis"),
  /** Returns profile names only; profile directories remain core-owned. */
  getCodexProfiles: () => call<string[]>("get_codex_profiles"),
  exportSessions: (toPath: string) => call<void>("export_sessions", { toPath }),
  importSessions: (fromPath: string) =>
    call<AppState>("import_sessions", { fromPath }),
};
