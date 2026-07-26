/** Small presentation helpers shared across views. */
import type { Folder, Session, Tool } from "../ipc/types";
import { TOOL_BADGE, TOOL_MODEL_FALLBACK } from "../components/lib/tokens";

export const LAUNCHABLE: Tool[] = ["claude", "codex", "copilot", "opencode", "terminal"];

export function toolName(tool: Tool): string {
  return TOOL_BADGE[tool].name;
}

export function displayModel(session: Session): string {
  return session.model ?? TOOL_MODEL_FALLBACK[session.tool];
}

export function folderOf(session: Session, folders: Folder[]): Folder | undefined {
  return folders.find((f) => f.id === session.folderId);
}

export function folderPathOf(session: Session, folders: Folder[]): string {
  return folderOf(session, folders)?.path ?? "";
}

/** Coarse relative time for the "last active" fields. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
