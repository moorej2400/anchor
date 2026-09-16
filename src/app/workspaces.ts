import {
  DEFAULT_WORKSPACE_ID,
  type Session,
  type Settings,
  type TerminalTheme,
  type Workspace,
} from "../ipc/types";

export const DEFAULT_TERMINAL_THEME: TerminalTheme = {
  background: "#0c0e0d",
  foreground: "#cbd0ce",
  cursor: "#88a99d",
  cursorAccent: "#0c0e0d",
  selectionBackground: "#34413c",
  selectionForeground: "#eef2f0",
  black: "#151817",
  red: "#cf7373",
  green: "#92bd94",
  yellow: "#d0b57a",
  blue: "#78a9d1",
  magenta: "#aea1c5",
  cyan: "#77b2ba",
  white: "#cbd0ce",
  brightBlack: "#68716d",
  brightRed: "#e38a8a",
  brightGreen: "#add3ae",
  brightYellow: "#e3ca91",
  brightBlue: "#94bee0",
  brightMagenta: "#c5b5dc",
  brightCyan: "#91c8ce",
  brightWhite: "#eef2f0",
};

export const DEFAULT_WORKSPACE: Workspace = {
  id: DEFAULT_WORKSPACE_ID,
  name: "Default",
  pinned: true,
  archived: false,
  favoriteSessionIds: [],
  folderOrder: [],
  tabOrder: [],
  collapsedFolderIds: [],
};

export function activeWorkspace(settings: Settings): Workspace {
  return settings.workspaces.find((workspace) => workspace.id === settings.activeWorkspaceId)
    ?? settings.workspaces.find((workspace) => !workspace.archived)
    ?? DEFAULT_WORKSPACE;
}

export function workspaceIdForSession(settings: Settings, sessionId: string): string {
  const id = settings.sessionWorkspaceIds[sessionId];
  return settings.workspaces.some((workspace) => workspace.id === id) ? id : DEFAULT_WORKSPACE_ID;
}

export function sessionsForWorkspace(
  sessions: Session[],
  settings: Settings,
  workspaceId = settings.activeWorkspaceId,
): Session[] {
  return sessions.filter((session) => workspaceIdForSession(settings, session.id) === workspaceId);
}

export function replaceWorkspace(
  settings: Settings,
  workspaceId: string,
  update: (workspace: Workspace) => Workspace,
): Workspace[] {
  return settings.workspaces.map((workspace) =>
    workspace.id === workspaceId ? update(workspace) : workspace
  );
}

export function workspaceForSession(settings: Settings, sessionId: string): Workspace {
  const workspaceId = workspaceIdForSession(settings, sessionId);
  return settings.workspaces.find((workspace) => workspace.id === workspaceId)
    ?? DEFAULT_WORKSPACE;
}
