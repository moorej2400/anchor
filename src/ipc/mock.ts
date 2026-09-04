/**
 * Browser-only mock IPC (VITE_IPC=mock) so the frontend can be built and demoed
 * without the Rust backend. It implements the full §6 contract with simulated
 * PTY output and status transitions. Seed data is SYNTHETIC — this is a public
 * repo; never put real paths, keys, or session IDs here.
 */
import type { AppState, CliInfo, Folder, Session, Settings, Status, Tool } from "./types";
import { EVENT } from "./types";

const now = () => new Date().toISOString();

let seq = 100;
const genId = () => {
  const h = () => Math.floor((seq * 2654435761) % 65536).toString(16).padStart(4, "0");
  seq += 7;
  return `${h()}-${h()}-${h()}`;
};

const folders: Folder[] = [
  { id: "f1", name: "acme-web", path: "~/dev/acme-web" },
  { id: "f2", name: "payments-api", path: "~/dev/payments-api" },
  { id: "f3", name: "mobile-app", path: "~/dev/mobile-app" },
  { id: "f4", name: "infra", path: "~/work/infra" },
];

function mk(
  id: string,
  folderId: string,
  tool: Tool,
  title: string,
  status: Status,
  cliSessionId: string | null,
  model: string | null,
): Session {
  return {
    id,
    folderId,
    tool,
    title,
    cliSessionId,
    status,
    model,
    extraArgs: [],
    createdAt: now(),
    lastActiveAt: now(),
    wasOpenInTab: status !== "stopped",
    codexProfile: null,
  };
}

const sessions: Session[] = [
  mk("w-claude", "f1", "claude", "refactor auth middleware", "running", "a3f9-7c21-e004", "claude-sonnet-4-6"),
  mk("w-copilot", "f1", "copilot", "revert last 3 commits", "running", "b1d0-4487-9aa2", "gpt-5"),
  mk("w-term", "f1", "terminal", "vite dev · :5173", "stopped", "tty-0091", "/bin/zsh"),
  { ...mk("api-codex", "f2", "codex", "fix checkout.spec timers", "waiting", "c8e2-1120-77af", "gpt-5-codex"), codexProfile: "work" },
  mk("api-claude", "f2", "claude", "add /sessions pagination", "stopped", "d4a1-9931-0b6c", "claude-sonnet-4-6"),
  mk("api-oc", "f2", "opencode", "stripe webhook retries", "stopped", "e7f3-5540-2c19", "anthropic/claude-4-6"),
  mk("m-copilot", "f3", "copilot", "expo build errors", "stopped", "f0b8-3372-84de", "gpt-5"),
  mk("m-claude", "f3", "claude", "dark mode tokens", "stopped", "a9c4-6610-df22", "claude-sonnet-4-6"),
  mk("i-term", "f4", "terminal", "terraform plan", "stopped", "tty-0044", "/bin/zsh"),
  mk("i-oc", "f4", "opencode", "k8s manifest audit", "stopped", "b2d9-7781-4a03", "anthropic/claude-4-6"),
];

const settings: Settings = {
  shell: "/bin/zsh",
  envVars: [{ key: "EDITOR", value: "nvim" }],
  autoRestore: true,
  confirmClose: true,
  stopOnClose: true,
  restoreScrollback: true,
  backupPath: "~/.anchor/sessions",
  projectsDir: "~/Documents/Anchor/Projects",
  retentionDays: 30,
  theme: "graphite",
  density: "comfortable",
  fontSize: 13,
  accent: "#d6417a",
  notifyOnWaiting: false,
};

const MODEL_FOR: Record<Tool, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-5-codex",
  copilot: "gpt-5",
  opencode: "anthropic/claude-4-6",
  terminal: "/bin/zsh",
};

// --- event bus ---
type Listener = { event: string; handler: (payload: unknown) => void };
const listeners: Listener[] = [];

export function mockEmit(event: string, payload: unknown): void {
  for (const l of listeners) if (l.event === event) l.handler(payload);
}

export function mockListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const l: Listener = { event, handler: handler as Listener["handler"] };
  listeners.push(l);
  return Promise.resolve(() => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  });
}

function setWaitingCount(): void {
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  mockEmit(EVENT.attentionCount, { waiting });
}

const outputSequences = new Map<string, number>();
const terminalGrids = new Map<string, { cols: number; rows: number; epoch: number }>();

function terminalGrid(id: string) {
  let grid = terminalGrids.get(id);
  if (!grid) {
    grid = { cols: 132, rows: 41, epoch: 1 };
    terminalGrids.set(id, grid);
  }
  return grid;
}

function nextOutputSequence(id: string): number {
  const sequence = (outputSequences.get(id) ?? 0) + 1;
  outputSequences.set(id, sequence);
  return sequence;
}

function emitOutput(id: string, lines: string[]): void {
  let i = 0;
  const tick = () => {
    if (i >= lines.length) return;
    const grid = terminalGrid(id);
    mockEmit(EVENT.ptyOutput, {
      sessionId: id,
      data: lines[i] + "\r\n",
      sequence: nextOutputSequence(id),
      gridEpoch: grid.epoch,
      cols: grid.cols,
      rows: grid.rows,
    });
    i++;
    window.setTimeout(tick, 90);
  };
  window.setTimeout(tick, 60);
}

function demoBanner(s: Session): string[] {
  const b = "[2m";
  const r = "[0m";
  const acc = "[38;2;224;122;160m";
  switch (s.tool) {
    case "claude":
      return [`${acc}✱ Claude Code${r} ${b}· ${s.folderId} · ${s.model}${r}`, "", `${acc}›${r} ${s.title}`, `[38;2;79;213;152m●${r} Working…`];
    case "codex":
      return [`[38;2;79;213;152mcodex${r} ${b}· ${s.model}${r}`, "", `[38;2;79;213;152m»${r} ${s.title}`, `[38;2;240;180;85mapply patch? [y/N]${r}`];
    case "copilot":
      return [`[38;2;119;182;242mGitHub Copilot CLI${r}`, "", `? ${s.title}`, `[38;2;79;213;152m●${r} git reset --soft HEAD~3`];
    case "opencode":
      return [`[38;2;185;139;230mopencode${r} ${b}· ${s.model}${r}`, "", `> ${s.title}`, `[38;2;79;213;152m●${r} Editing api/sessions.ts`];
    default:
      return [`${b}── restored session · scrollback recovered (2,481 lines) ──${r}`, "", `user@mac ${b}${s.folderId} %${r} npm run dev`, `[38;2;119;182;242m  VITE ready${r}`];
  }
}

function goRunning(s: Session): void {
  s.status = "running";
  s.lastActiveAt = now();
  mockEmit(EVENT.sessionStatus, { sessionId: s.id, status: "running", exitCode: null });
  emitOutput(s.id, demoBanner(s));
  setWaitingCount();
}

export function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const a = (args ?? {}) as Record<string, unknown>;
  const find = (id: string) => sessions.find((s) => s.id === id);

  switch (cmd) {
    case "get_state":
      return Promise.resolve({ folders: [...folders], sessions: sessions.map((s) => ({ ...s })) } as T);
    case "frontend_ready":
      // Browser mock: sessions are already seeded, so readiness is a no-op.
      return Promise.resolve({ cols: a.cols, rows: a.rows } as T);
    case "get_settings":
      return Promise.resolve({ ...settings } as T);
    case "set_settings": {
      Object.assign(settings, (a.settings as Settings) ?? {});
      return Promise.resolve({ ...settings } as T);
    }
    case "detect_clis":
      return Promise.resolve(
        (["claude", "codex", "copilot", "opencode", "terminal"] as Tool[]).map((tool) => ({
          tool,
          found: true,
          version: "0.0.0-mock",
          path: `/mock/bin/${tool}`,
        })) as CliInfo[] as T,
      );
    case "get_codex_profiles":
      // Names are deliberately generic public fixture data, never local account details.
      return Promise.resolve(["work", "personal"] as T);
    case "launch_session": {
      const tool = a.tool as Tool;
      const id = `n${(seq += 1)}`;
      const s = mk(id, a.folderId as string, tool, `new ${tool} session`, "running", tool === "terminal" ? `tty-${id}` : genId(), MODEL_FOR[tool]);
      s.codexProfile = tool === "codex" ? (a.codexProfile as string | null | undefined) ?? null : null;
      sessions.push(s);
      goRunning(s);
      return Promise.resolve({ ...s } as T);
    }
    case "resume_session": {
      const s = find(a.sessionId as string);
      if (!s) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      goRunning(s);
      return Promise.resolve({ ...s } as T);
    }
    case "repair_session_identity": {
      const s = find(a.sessionId as string);
      if (!s) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      if (s.cliSessionId) return Promise.reject("SESSION_ID_ALREADY_AVAILABLE: provider ID exists");
      s.cliSessionId = genId();
      goRunning(s);
      return Promise.resolve({ ...s } as T);
    }
    case "fork_codex_session": {
      const source = find(a.sessionId as string);
      if (!source) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      if (source.tool !== "codex") {
        return Promise.reject("SESSION_FORK_UNSUPPORTED: only Codex sessions can be forked");
      }
      const id = `n${(seq += 1)}`;
      const fork = mk(
        id,
        source.folderId,
        "codex",
        `${source.title} (fork)`,
        "running",
        genId(),
        source.model,
      );
      fork.codexProfile = source.codexProfile;
      sessions.push(fork);
      goRunning(fork);
      return Promise.resolve({ ...fork } as T);
    }
    case "stop_session": {
      const s = find(a.sessionId as string);
      if (s) {
        s.status = "stopped";
        mockEmit(EVENT.sessionStatus, { sessionId: s.id, status: "stopped", exitCode: 0 });
        setWaitingCount();
      }
      return Promise.resolve(undefined as T);
    }
    case "delete_session": {
      const i = sessions.findIndex((s) => s.id === (a.sessionId as string));
      if (i >= 0) sessions.splice(i, 1);
      return Promise.resolve(undefined as T);
    }
    case "rename_session": {
      const s = find(a.sessionId as string);
      if (!s) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      s.title = (a.title as string) || "untitled";
      return Promise.resolve({ ...s } as T);
    }
    case "set_session_id": {
      const s = find(a.sessionId as string);
      if (!s) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      s.cliSessionId = String(a.cliSessionId ?? "");
      return Promise.resolve({ ...s } as T);
    }
    case "generate_session_title": {
      const s = find(a.sessionId as string);
      if (!s) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      s.title = "Generated Synthetic Chat Title";
      mockEmit(EVENT.sessionUpdated, { ...s });
      return Promise.resolve({ ...s } as T);
    }
    case "set_codex_profile": {
      const s = find(a.sessionId as string);
      if (!s) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      if (s.tool !== "codex") return Promise.reject("CODEX_PROFILE_UNSUPPORTED: only Codex sessions have profiles");
      const profile = (a.codexProfile as string | null | undefined) ?? null;
      if (profile !== null && !["work", "personal"].includes(profile)) {
        return Promise.reject("CODEX_PROFILE_UNAVAILABLE: profile is no longer available");
      }
      s.codexProfile = profile;
      return Promise.resolve({ ...s } as T);
    }
    case "set_tab_open": {
      const s = find(a.sessionId as string);
      if (!s) return Promise.resolve(undefined as T);
      const open = Boolean(a.open);
      s.wasOpenInTab = open;
      // The sole close lifecycle command (SPEC.md §8): with `stopOnClose` the
      // real backend stops the PTY here, which is what leaves the session
      // resumable with its saved provider ID. Without this the mock reports a
      // closed tab as still running and its resume path can never be exercised.
      if (!open && settings.stopOnClose && s.status !== "stopped") {
        s.status = "stopped";
        mockEmit(EVENT.sessionStatus, { sessionId: s.id, status: "stopped", exitCode: 0 });
        setWaitingCount();
      }
      return Promise.resolve(undefined as T);
    }
    case "create_project": {
      const name = String(a.name ?? "").trim();
      if (!name) return Promise.reject("PROJECT_NAME_INVALID: name is required");
      const path = `${settings.projectsDir}/${name}`;
      const folder: Folder = { id: `f${(seq += 1)}`, name, path };
      folders.push(folder);
      return Promise.resolve({ ...folder } as T);
    }
    case "pick_folder": {
      // Browser mock: the native picker cannot run here, so return a synthetic
      // path. This is a public repo — never a real filesystem path.
      return Promise.resolve("~/Developer/picked-folder" as T);
    }
    case "create_folder": {
      const path = a.path as string;
      const name = (a.name as string) || path.split("/").filter(Boolean).pop() || path;
      const folder: Folder = { id: `f${(seq += 1)}`, name, path };
      folders.push(folder);
      return Promise.resolve({ ...folder } as T);
    }
    case "rename_folder": {
      const f = folders.find((x) => x.id === (a.folderId as string));
      if (!f) return Promise.reject("FOLDER_NOT_FOUND: unknown id");
      f.name = (a.name as string) || "untitled";
      return Promise.resolve({ ...f } as T);
    }
    case "remove_folder": {
      const id = a.folderId as string;
      for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].folderId === id) sessions.splice(i, 1);
      const fi = folders.findIndex((f) => f.id === id);
      if (fi >= 0) folders.splice(fi, 1);
      return Promise.resolve(undefined as T);
    }
    case "write_pty": {
      // Local echo so typing is visible in the demo.
      const id = a.sessionId as string;
      const grid = terminalGrid(id);
      mockEmit(EVENT.ptyOutput, {
        sessionId: id,
        data: a.data as string,
        sequence: nextOutputSequence(id),
        gridEpoch: grid.epoch,
        cols: grid.cols,
        rows: grid.rows,
      });
      return Promise.resolve(undefined as T);
    }
    case "resize_pty": {
      const id = a.sessionId as string;
      const grid = terminalGrid(id);
      const cols = a.cols as number;
      const rows = a.rows as number;
      if (grid.cols !== cols || grid.rows !== rows) {
        grid.cols = cols;
        grid.rows = rows;
        grid.epoch += 1;
      }
      return Promise.resolve({
        throughSequence: outputSequences.get(id) ?? 0,
        gridEpoch: grid.epoch,
      } as T);
    }
    case "replay_output": {
      const id = a.sessionId as string;
      const grid = terminalGrid(id);
      return Promise.resolve({
        data: "",
        throughSequence: outputSequences.get(id) ?? 0,
        cols: grid.cols,
        rows: grid.rows,
        coversUnsequenced: false,
        gridEpoch: grid.epoch,
      } as T);
    }
    case "get_scrollback":
      return Promise.resolve("" as T);
    case "export_sessions":
      return Promise.resolve(undefined as T);
    case "import_sessions":
      return Promise.resolve({ folders: [...folders], sessions: sessions.map((s) => ({ ...s })) } as AppState as T);
    default:
      return Promise.reject(`MOCK_NOT_IMPLEMENTED: ${cmd}`);
  }
}
