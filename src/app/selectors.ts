/** Derived views over Anchor state (pure). */
import type { Folder, Session, Status } from "../ipc/types";
import { TOOL_BADGE } from "../components/lib/tokens";

export interface FolderWithSessions extends Folder {
  sessions: Session[];
}

/** Rank for waiting-first sorting: waiting (needs attention) sorts to the top. */
function attentionRank(status: Status): number {
  return status === "waiting" ? 0 : 1;
}

/** Does a session match the filter query (title, folder, tool name, session id)? */
export function sessionMatches(session: Session, folder: Folder, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${session.title} ${folder.name} ${TOOL_BADGE[session.tool].name} ${session.cliSessionId ?? ""}`;
  return hay.toLowerCase().includes(q);
}

/**
 * Folders with their sessions filtered by `query` and sorted waiting-first
 * (stable within rank). When filtering, empty folders are dropped.
 */
export function foldersWithSessions(
  folders: Folder[],
  sessions: Session[],
  query: string,
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
    // Stable sort: decorate with original index so equal ranks keep order.
    list
      .map((s, i) => [s, i] as const)
      .sort((a, b) => attentionRank(a[0].status) - attentionRank(b[0].status) || a[1] - b[1])
      .forEach((pair, i) => (list[i] = pair[0]));
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
