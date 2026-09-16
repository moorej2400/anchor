import { describe, expect, it } from "vitest";
import type { Folder, Session, Status, Tool } from "../ipc/types";
import {
  EMPTY_FOLDER_HIDE_AFTER_MS,
  favoriteSessions,
  foldersWithSessions,
  moveFolderId,
  moveOrderedId,
  orderFolders,
  orderIds,
  reconcileEmptyFolderSinceMs,
  responseIndicator,
  sessionDisplayTitle,
  sessionMatches,
  splitHiddenFolders,
  statusCounts,
} from "./selectors";

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
    codexProfile: null,
  };
}

describe("foldersWithSessions", () => {
  it("keeps registry order when the user has submitted nothing", () => {
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

  it("promotes the most recently submitted session to the top of its folder", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "running"),
      s("c", "f1", "copilot", "three", "running"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "", { c: 1 });
    expect(g.sessions.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("orders several submitted sessions most-recent-first", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f1", "codex", "two", "running"),
      s("c", "f1", "copilot", "three", "running"),
    ];
    const [g] = foldersWithSessions(folders, sessions, "", { a: 1, c: 2, b: 3 });
    expect(g.sessions.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps never-submitted sessions in registry order below submitted ones", () => {
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

describe("folder ordering", () => {
  it("applies saved order and appends newly discovered folders", () => {
    const third: Folder = { id: "f3", name: "new", path: "~/dev/new" };
    expect(orderFolders([...folders, third], ["f2", "f1"]).map((folder) => folder.id)).toEqual([
      "f2", "f1", "f3",
    ]);
  });

  it("moves a folder before or after a target", () => {
    expect(moveFolderId(["f1", "f2", "f3"], "f3", "f1", false)).toEqual(["f3", "f1", "f2"]);
    expect(moveFolderId(["f1", "f2", "f3"], "f1", "f2", true)).toEqual(["f2", "f1", "f3"]);
  });
});

describe("generic id ordering", () => {
  it("restores saved ids first and appends ids missing from the saved order", () => {
    expect(orderIds(["a", "b", "c"], ["c", "a", "stale"])).toEqual(["c", "a", "b"]);
  });

  it("moves an id before or after a target", () => {
    expect(moveOrderedId(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(moveOrderedId(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
  });
});

describe("empty folder hiding", () => {
  const now = Date.UTC(2026, 0, 2, 12);

  it("records only currently empty folders and preserves their original empty time", () => {
    const sessions = [s("a", "f1", "claude", "one", "stopped")];
    const previous = { f1: now - 1_000, f2: now - 2_000, stale: now - 3_000 };

    expect(reconcileEmptyFolderSinceMs(folders, sessions, previous, now)).toEqual({
      f2: now - 2_000,
    });
  });

  it("starts a fresh 12-hour window for a newly empty folder", () => {
    expect(reconcileEmptyFolderSinceMs([folders[0]], [], {}, now)).toEqual({ f1: now });
  });

  it("moves only continuously empty folders older than 12 hours into Hidden", () => {
    const groups = foldersWithSessions(folders, [], "");
    const split = splitHiddenFolders(groups, {
      f1: now - EMPTY_FOLDER_HIDE_AFTER_MS,
      f2: now - EMPTY_FOLDER_HIDE_AFTER_MS + 1,
    }, now);

    expect(split.hidden.map((folder) => folder.id)).toEqual(["f1"]);
    expect(split.visible.map((folder) => folder.id)).toEqual(["f2"]);
  });

  it("never hides a folder that contains a session", () => {
    const groups = foldersWithSessions(folders, [s("a", "f1", "claude", "one", "stopped")], "");
    const split = splitHiddenFolders(groups, { f1: 0, f2: 0 }, now);

    expect(split.hidden.map((folder) => folder.id)).toEqual(["f2"]);
    expect(split.visible.map((folder) => folder.id)).toEqual(["f1"]);
  });
});

describe("favorites", () => {
  it("keeps explicit favorite order and ignores stale ids", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f2", "codex", "two", "running"),
    ];
    expect(favoriteSessions(sessions, folders, ["missing", "b", "a"], "").map((session) => session.id)).toEqual([
      "b", "a",
    ]);
  });

  it("uses the normal session filter", () => {
    const sessions = [
      s("a", "f1", "claude", "one", "running"),
      s("b", "f2", "codex", "two", "running"),
    ];
    expect(favoriteSessions(sessions, folders, ["a", "b"], "payments").map((session) => session.id)).toEqual(["b"]);
  });
});

describe("responseIndicator", () => {
  it("hides closed chats and distinguishes open from response-ready chats", () => {
    expect(responseIndicator("a", [], { a: true })).toBeNull();
    expect(responseIndicator("a", ["a"], {})).toBe("idle");
    expect(responseIndicator("a", ["a"], { a: true })).toBe("ready");
  });
});

describe("sessionDisplayTitle", () => {
  it("numbers duplicate titles in stable creation and id order", () => {
    const first = s("a", "f1", "codex", "new Codex session", "stopped");
    const second = s("b", "f1", "codex", "new Codex session", "stopped");
    const unique = s("c", "f1", "claude", "new Claude session", "stopped");
    const sessions = [second, unique, first];

    expect(sessionDisplayTitle(first, sessions)).toBe("new Codex session (1)");
    expect(sessionDisplayTitle(second, sessions)).toBe("new Codex session (2)");
    expect(sessionDisplayTitle(unique, sessions)).toBe("new Claude session");
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
