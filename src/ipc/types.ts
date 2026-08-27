/**
 * IPC contract types — the backend ↔ frontend boundary.
 * Normative source: docs/SPEC.md §6. Do not change without updating SPEC.md
 * in the same commit. Rust mirrors these with serde(rename_all = "camelCase").
 */

export type Tool = "claude" | "codex" | "copilot" | "opencode" | "terminal";
export type Status = "running" | "waiting" | "stopped";

export interface Folder {
  id: string;
  name: string;
  path: string;
}

export interface Session {
  id: string;
  folderId: string;
  tool: Tool;
  title: string;
  cliSessionId: string | null;
  status: Status;
  model: string | null;
  extraArgs: string[];
  createdAt: string; // ISO-8601
  lastActiveAt: string; // ISO-8601
  wasOpenInTab: boolean;
  /** Codex configuration profile used for its next launch or resume. */
  codexProfile: string | null;
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface Settings {
  shell: string;
  envVars: EnvVar[];
  autoRestore: boolean;
  confirmClose: boolean;
  stopOnClose: boolean;
  restoreScrollback: boolean;
  backupPath: string;
  /** Where "Create a new project" makes folders. */
  projectsDir: string;
  retentionDays: number;
  theme: "graphite" | "obsidian" | "nebula";
  density: "comfortable" | "compact";
  fontSize: number;
  accent: string;
  notifyOnWaiting: boolean;
}

export interface CliInfo {
  tool: Tool;
  found: boolean;
  version: string | null;
  path: string | null;
}

/** Measured xterm grid used for the initial PTY spawn and later resizes. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface PtyResize {
  /** Last output sequence produced before the PTY accepted the new grid. */
  throughSequence: number;
  gridEpoch: number;
}

export interface AppState {
  folders: Folder[];
  sessions: Session[];
}


/** Event payloads (Rust → frontend). */
export interface PtyOutputPayload {
  sessionId: string;
  data: string;
  sequence: number;
  gridEpoch: number;
  cols: number;
  rows: number;
}

export interface PtyReplay {
  data: string;
  throughSequence: number;
  cols: number;
  rows: number;
  /** True when the snapshot includes saved output emitted outside live sequencing. */
  coversUnsequenced: boolean;
  gridEpoch: number;
}

export interface SessionStatusPayload {
  sessionId: string;
  status: Status;
  exitCode: number | null;
}

export interface SessionResumeErrorPayload {
  sessionId: string;
  code: string;
  message: string;
}

export interface AttentionCountPayload {
  waiting: number;
}

export const EVENT = {
  ptyOutput: "pty:output",
  sessionStatus: "session:status",
  sessionUpdated: "session:updated",
  sessionResumeError: "session:resume-error",
  attentionCount: "attention:count",
} as const;
