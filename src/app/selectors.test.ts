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
  it("keeps registry order when the user has typed in nothing", () => {
    const sessions = [
      s("a", "f1", "claude", "running one", "running"),
      s("b", "f1", "codex", "stopped one", "stopped"),
      s("c", "f1", "copilot", "waiting one", "waiting"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "");
    expect(g.sessions.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("does not reorder when a session's status changes", () => {
    const before = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "running"),
      s("c", "f1", "copilot", "three", "running"),
    ];
    const after = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "waiting"),
      s("c", "f1", "copilot", "three", "running"),
    ];
    // The 3s idle detector flips sessions between running and waiting
    // constantly; position must not follow it.
    expect(foldersWithSessions(folders, before, "")[0].sessions.map((x) => x.id)).toEqual(
      foldersWithSessions(folders, after, "")[0].sessions.map((x) => x.id),
    );
  });

  it("promotes the most recently typed-in session to the top of its folder", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "running"),
      s("c", "f1", "copilot", "three", "running"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "", { c: 1 });
    expect(g.sessions.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("orders several typed-in sessions most-recent-first", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "running"),
      s("c", "f1", "copilot", "three", "running"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "", { a: 1, c: 2, b: 3 });
    expect(g.sessions.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps never-typed sessions in registry order below typed ones", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "running"),
      s("c", "f1", "copilot", "three", "running"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "", { b: 1 });
    expect(g.sessions.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("promotes only within the session's own folder", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "running"),
      s("x", "f2", "claude", "other", "running"),
      s("y", "f2", "codex", "other two", "running"),
    ];
    const [first, second] = foldersWithSessions(folders, sessions, "", { y: 1 });
    expect(first.sessions.map((v) => v.id)).toEqual(["a", "b"]);
    expect(second.sessions.map((v) => v.id)).toEqual(["y", "x"]);
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
