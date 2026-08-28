/** Derived views over Anchor state (pure). */
import type { Folder, Session, Status } from "../ipc/types";
import { TOOL_BADGE } from "../components/lib/tokens";

export interface FolderWithSessions extends Folder {
  sessions: Session[];
}

/**
 * Monotonic "last typed into" sequence per session id. Higher is more recent;
 * a missing id means the user has never typed into that session.
 */
export type TypedOrder = Record<string, number>;

/**
 * Keep separate saved sessions identifiable when older registries contain the
 * same default title more than once. The stable creation/id order avoids row
 * labels changing when activity sorting moves a session in the sidebar.
 */
export function sessionDisplayTitle(session: Session, sessions: Session[]): string {
  const matches = sessions
    .filter((candidate) => candidate.title === session.title)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  if (matches.length < 2) return session.title;
  const index = matches.findIndex((candidate) => candidate.id === session.id);
  return index < 0 ? session.title : `${session.title} (${index + 1})`;
}

/** Does a session match the filter query (title, folder, tool name, session id)? */
export function sessionMatches(session: Session, folder: Folder, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${session.title} ${folder.name} ${TOOL_BADGE[session.tool].name} ${session.cliSessionId ?? ""}`;
  return hay.toLowerCase().includes(q);
}

/**
 * Folders with their sessions filtered by `query` and ordered by *user
 * activity*: the session the user most recently typed into sits at the top of
 * its folder, then the next most recent, and so on; sessions never typed into
 * keep registry order below them. When filtering, empty folders are dropped.
 *
 * Deliberately independent of `status`. The idle detector flips ON sessions
 * between running and waiting every few seconds (SPEC §4), so ranking by
 * status made rows jump on their own. Selecting a session does not reorder it
 * either — only typing does.
 */
export function foldersWithSessions(
  folders: Folder[],
  sessions: Session[],
  query: string,
  typedOrder: TypedOrder = {},
): FolderWithSessions[] {
  const byFolder = new Map<string, Session[]>();
  for (const s of sessions) {
    const folder = folders.find((f) => f.id === s.folderId);
    if (!folder) continue;
    if (!sessionMatches(s, folder, query)) continue;
    const list = byFolder.get(s.folderId) ?? [];
    list.push(s);
    byFolder.set(s.folderId, list);
  }
  const result: FolderWithSessions[] = folders.map((f) => {
    const list = (byFolder.get(f.id) ?? []).slice();
    // Typed-in sessions first, most recent at the top. Decorating with the
    // original index keeps never-typed sessions in registry order.
    list
      .map((s, i) => [s, i, typedOrder[s.id] ?? 0] as const)
      .sort((a, b) => b[2] - a[2] || a[1] - b[1])
      .forEach((entry, i) => (list[i] = entry[0]));
    return { ...f, sessions: list };
  });
  return query.trim() ? result.filter((f) => f.sessions.length > 0) : result;
}

export interface StatusCounts {
  running: number;
  waiting: number;
  stopped: number;
}

export function statusCounts(sessions: Session[]): StatusCounts {
  const counts: StatusCounts = { running: 0, waiting: 0, stopped: 0 };
  for (const s of sessions) counts[s.status]++;
  return counts;
}

export function sessionById(sessions: Session[], id: string | null): Session | null {
  if (!id) return null;
  return sessions.find((s) => s.id === id) ?? null;
}

export function isOn(status: Status): boolean {
  return status === "running" || status === "waiting";
}
