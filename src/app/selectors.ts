/** Derived views over Anchor state (pure). */
import type { Folder, Session, Status } from "../ipc/types";
import { TOOL_BADGE } from "../components/lib/tokens";

export interface FolderWithSessions extends Folder {
  sessions: Session[];
}

export const EMPTY_FOLDER_HIDE_AFTER_MS = 12 * 60 * 60 * 1000;

export interface FolderVisibilityGroups {
  visible: FolderWithSessions[];
  hidden: FolderWithSessions[];
}

/**
 * Monotonic "last submitted to" sequence per session id. Higher is more
 * recent; a missing id means the user has never sent input to that session.
 */
export type SubmittedOrder = Record<string, number>;

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
 * activity*: the session the user most recently submitted into sits at the top of
 * its folder, then the next most recent, and so on; sessions with no submission
 * keep registry order below them. When filtering, empty folders are dropped.
 *
 * Deliberately independent of `status`. The idle detector flips ON sessions
 * between running and waiting every few seconds (SPEC §4), so ranking by
 * status made rows jump on their own. Selecting a session does not reorder it
 * either — only completed input submissions do.
 */
export function foldersWithSessions(
  folders: Folder[],
  sessions: Session[],
  query: string,
  submittedOrder: SubmittedOrder = {},
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
    // Submitted-to sessions first, most recent at the top. Decorating with the
    // original index keeps untouched sessions in registry order.
    list
      .map((s, i) => [s, i, submittedOrder[s.id] ?? 0] as const)
      .sort((a, b) => b[2] - a[2] || a[1] - b[1])
      .forEach((entry, i) => (list[i] = entry[0]));
    return { ...f, sessions: list };
  });
  return query.trim() ? result.filter((f) => f.sessions.length > 0) : result;
}

/** Apply the saved project-group order without hiding newly discovered folders. */
export function orderFolders(folders: Folder[], folderOrder: string[]): Folder[] {
  const rank = new Map(folderOrder.map((id, index) => [id, index]));
  return folders
    .map((folder, registryIndex) => ({ folder, registryIndex, rank: rank.get(folder.id) }))
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) return left.rank - right.rank;
      if (left.rank !== undefined) return -1;
      if (right.rank !== undefined) return 1;
      return left.registryIndex - right.registryIndex;
    })
    .map(({ folder }) => folder);
}

/** Apply a saved id order while retaining newly discovered ids at the end. */
export function orderIds(ids: string[], savedOrder: string[]): string[] {
  const rank = new Map(savedOrder.map((id, index) => [id, index]));
  return ids
    .map((id, originalIndex) => ({ id, originalIndex, rank: rank.get(id) }))
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) return left.rank - right.rank;
      if (left.rank !== undefined) return -1;
      if (right.rank !== undefined) return 1;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ id }) => id);
}

/** Move one id before or after another while preserving every other id. */
export function moveOrderedId(
  ids: string[],
  movingId: string,
  targetId: string,
  after: boolean,
): string[] {
  if (movingId === targetId || !ids.includes(movingId) || !ids.includes(targetId)) return ids;
  const next = ids.filter((id) => id !== movingId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (after ? 1 : 0), 0, movingId);
  return next;
}

/** Move one folder before or after another while preserving every other id. */
export function moveFolderId(
  folderIds: string[],
  movingId: string,
  targetId: string,
  after: boolean,
): string[] {
  return moveOrderedId(folderIds, movingId, targetId, after);
}

/**
 * Record when each currently empty folder became empty. Removing entries for
 * non-empty or deleted folders restarts the full 12-hour window if they empty
 * again and keeps stale folder identifiers out of persisted settings.
 */
export function reconcileEmptyFolderSinceMs(
  folders: Folder[],
  sessions: Session[],
  previous: Record<string, number>,
  nowMs: number,
): Record<string, number> {
  const nonEmptyFolderIds = new Set(sessions.map((session) => session.folderId));
  const next: Record<string, number> = {};
  for (const folder of folders) {
    if (nonEmptyFolderIds.has(folder.id)) continue;
    const saved = previous[folder.id];
    next[folder.id] = Number.isFinite(saved) && saved >= 0 && saved <= nowMs ? saved : nowMs;
  }
  const previousKeys = Object.keys(previous);
  return previousKeys.length === Object.keys(next).length
    && previousKeys.every((id) => previous[id] === next[id])
    ? previous
    : next;
}

/** Empty folders move into Hidden only after one continuous 12-hour window. */
export function splitHiddenFolders(
  groups: FolderWithSessions[],
  emptyFolderSinceMs: Record<string, number>,
  nowMs: number,
): FolderVisibilityGroups {
  const visible: FolderWithSessions[] = [];
  const hidden: FolderWithSessions[] = [];
  for (const group of groups) {
    const emptySince = emptyFolderSinceMs[group.id];
    const isHidden = group.sessions.length === 0
      && Number.isFinite(emptySince)
      && nowMs - emptySince >= EMPTY_FOLDER_HIDE_AFTER_MS;
    (isHidden ? hidden : visible).push(group);
  }
  return { visible, hidden };
}

/** Favorite chat shortcuts retain the explicit order chosen in Settings. */
export function favoriteSessions(
  sessions: Session[],
  folders: Folder[],
  favoriteSessionIds: string[],
  query: string,
): Session[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  return favoriteSessionIds.flatMap((id) => {
    const session = sessionsById.get(id);
    const folder = session ? foldersById.get(session.folderId) : undefined;
    return session && folder && sessionMatches(session, folder, query) ? [session] : [];
  });
}

export type ResponseIndicator = "idle" | "ready" | null;

/** Closed chats never render an indicator; open chats are gray or unread blue. */
export function responseIndicator(
  sessionId: string,
  openTabs: string[],
  unreadResponses: Record<string, true>,
): ResponseIndicator {
  if (!openTabs.includes(sessionId)) return null;
  return unreadResponses[sessionId] ? "ready" : "idle";
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
