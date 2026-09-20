import { describe, expect, it } from "vitest";
import type { Session, Settings, Workspace } from "../ipc/types";
import {
  DEFAULT_TERMINAL_THEME,
  DEFAULT_WORKSPACE,
  activeWorkspace,
  replaceWorkspace,
  sessionsForWorkspace,
  workspaceForSession,
  workspaceIdForSession,
} from "./workspaces";

const SECOND_WORKSPACE: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Release planning",
  pinned: false,
  archived: false,
  favoriteSessionIds: [],
  folderOrder: [],
  tabOrder: [],
  collapsedFolderIds: [],
};

const SETTINGS: Settings = {
  shell: "/bin/sh",
  envVars: [],
  autoRestore: true,
  confirmClose: true,
  stopOnClose: true,
  restoreScrollback: true,
  backupPath: "~/.anchor/sessions",
  projectsDir: "~/Documents/Anchor/Projects",
  retentionDays: 30,
  scrollbackLineLimit: 10_000,
  theme: "graphite",
  density: "comfortable",
  fontSize: 13,
  accent: "#88a99d",
  notifyOnWaiting: false,
  responseReadDelayMs: 1_000,
  favoriteSessionIds: [],
  folderOrder: [],
  tabOrder: [],
  emptyFolderSinceMs: {},
  workspaces: [DEFAULT_WORKSPACE, SECOND_WORKSPACE],
  activeWorkspaceId: SECOND_WORKSPACE.id,
  sessionWorkspaceIds: { release: SECOND_WORKSPACE.id },
  workspacePaneKeepOpen: false,
  terminalTheme: DEFAULT_TERMINAL_THEME,
  customHarnesses: [],
  sessionHarnessIds: {},
};

function session(id: string): Session {
  return {
    id,
    folderId: "folder",
    tool: "terminal",
    title: id,
    cliSessionId: null,
    status: "stopped",
    model: null,
    extraArgs: [],
    codexProfile: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    wasOpenInTab: false,
  };
}

describe("workspace ownership", () => {
  it("keeps unmapped legacy sessions in the stable Default workspace", () => {
    expect(workspaceIdForSession(SETTINGS, "legacy")).toBe(DEFAULT_WORKSPACE.id);
    expect(workspaceForSession(SETTINGS, "legacy").name).toBe("Default");
  });

  it("filters sessions without duplicating them between workspaces", () => {
    const sessions = [session("legacy"), session("release")];
    expect(sessionsForWorkspace(sessions, SETTINGS).map(({ id }) => id)).toEqual(["release"]);
    expect(sessionsForWorkspace(sessions, SETTINGS, DEFAULT_WORKSPACE.id).map(({ id }) => id))
      .toEqual(["legacy"]);
  });

  it("resolves the active workspace and updates only the requested record", () => {
    expect(activeWorkspace(SETTINGS)).toEqual(SECOND_WORKSPACE);
    const updated = replaceWorkspace(SETTINGS, SECOND_WORKSPACE.id, (workspace) => ({
      ...workspace,
      name: "Renamed",
    }));
    expect(updated[0]).toEqual(DEFAULT_WORKSPACE);
    expect(updated[1].name).toBe("Renamed");
  });
});
