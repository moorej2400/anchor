import { describe, expect, it } from "vitest";
import type { Folder, Session, Status, Tool } from "../ipc/types";
import { foldersWithSessions, sessionMatches, statusCounts } from "./selectors";

const folders: Folder[] = [
  { id: "f1", name: "acme-web", path: "~/dev/acme-web" },
  { id: "f2", name: "payments-api", path: "~/dev/payments-api" },
];

function s(id: string, folderId: string, tool: Tool, title: string, status: Status): Session {
  return {
    id,
    folderId,
    tool,
    title,
    cliSessionId: `${id}-sid`,
    status,
    model: null,
    extraArgs: [],
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    wasOpenInTab: false,
  };
}

describe("foldersWithSessions", () => {
  it("sorts waiting sessions to the top of their folder (attention priority)", () => {
    const sessions = [
      s("a", "f1", "claude", "running one", "running"),
      s("b", "f1", "codex", "stopped one", "stopped"),
      s("c", "f1", "copilot", "waiting one", "waiting"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "");
    expect(g.sessions.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("is a stable sort within the same attention rank", () => {
    const sessions = [
      s("a", "f1", "claude", "first running", "running"),
      s("b", "f1", "codex", "second running", "running"),
      s("c", "f1", "copilot", "waiting", "waiting"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "");
    expect(g.sessions.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("drops empty folders only when a filter is active", () => {
    const sessions = [s("a", "f1", "claude", "auth work", "running")];
    expect(foldersWithSessions(folders, sessions, "").length).toBe(2);
    const filtered = foldersWithSessions(folders, sessions, "auth");
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe("f1");
  });
});

describe("sessionMatches", () => {
  it("matches on title, folder name, tool name, and session id", () => {
    const sess = s("a", "f1", "claude", "refactor auth", "running");
    expect(sessionMatches(sess, folders[0], "refactor")).toBe(true);
    expect(sessionMatches(sess, folders[0], "acme")).toBe(true);
    expect(sessionMatches(sess, folders[0], "Claude Code")).toBe(true);
    expect(sessionMatches(sess, folders[0], "a-sid")).toBe(true);
    expect(sessionMatches(sess, folders[0], "nope")).toBe(false);
  });
});

describe("statusCounts", () => {
  it("counts each status", () => {
    const sessions = [
      s("a", "f1", "claude", "1", "running"),
      s("b", "f1", "codex", "2", "waiting"),
      s("c", "f1", "copilot", "3", "stopped"),
      s("d", "f2", "opencode", "4", "stopped"),
    ];
    expect(statusCounts(sessions)).toEqual({ running: 1, waiting: 1, stopped: 2 });
  });
});
