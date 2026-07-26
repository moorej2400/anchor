/**
 * Typed command wrappers — the ONLY place `invoke` may appear in the frontend.
 * Contract: docs/SPEC.md §6.2.
 * Set VITE_IPC=mock to run against src/ipc/mock.ts in a plain browser.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppState, CliInfo, Folder, Session, Settings, Tool } from "./types";
import { mockInvoke } from "./mock";

const useMock = import.meta.env.VITE_IPC === "mock";

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return useMock ? mockInvoke<T>(cmd, args) : invoke<T>(cmd, args);
}

export const ipc = {
  getState: () => call<AppState>("get_state"),

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
    title?: string,
    extraArgs?: string[],
  ) => call<Session>("launch_session", { folderId, tool, title, extraArgs }),
  resumeSession: (sessionId: string) =>
    call<Session>("resume_session", { sessionId }),
  stopSession: (sessionId: string) => call<void>("stop_session", { sessionId }),
  deleteSession: (sessionId: string) =>
    call<void>("delete_session", { sessionId }),
  renameSession: (sessionId: string, title: string) =>
    call<Session>("rename_session", { sessionId, title }),
  setTabOpen: (sessionId: string, open: boolean) =>
    call<void>("set_tab_open", { sessionId, open }),

  writePty: (sessionId: string, data: string) =>
    call<void>("write_pty", { sessionId, data }),
  resizePty: (sessionId: string, cols: number, rows: number) =>
    call<void>("resize_pty", { sessionId, cols, rows }),
  getScrollback: (sessionId: string) =>
    call<string>("get_scrollback", { sessionId }),

  getSettings: () => call<Settings>("get_settings"),
  setSettings: (settings: Settings) =>
    call<Settings>("set_settings", { settings }),

  detectClis: () => call<CliInfo[]>("detect_clis"),
  exportSessions: (toPath: string) => call<void>("export_sessions", { toPath }),
  importSessions: (fromPath: string) =>
    call<AppState>("import_sessions", { fromPath }),
};
