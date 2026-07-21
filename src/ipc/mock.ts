/**
 * Browser-only mock IPC (VITE_IPC=mock) so the frontend can be built and
 * demoed without the Rust backend. Phase 3 extends this with richer simulated
 * behavior (status flips, fake PTY output). Seed data is SYNTHETIC — this is
 * a public repo; never put real paths/keys here.
 */
import type { AppState, Session, Settings } from "./types";

const now = () => new Date().toISOString();

const state: AppState = {
  folders: [
    { id: "f1", name: "acme-web", path: "~/dev/acme-web" },
    { id: "f2", name: "payments-api", path: "~/dev/payments-api" },
  ],
  sessions: [
    {
      id: "s1",
      folderId: "f1",
      tool: "claude",
      title: "refactor auth middleware",
      cliSessionId: "a3f9-7c21-e004",
      status: "stopped",
      model: "claude-sonnet-4-6",
      extraArgs: [],
      createdAt: now(),
      lastActiveAt: now(),
      wasOpenInTab: true,
    },
    {
      id: "s2",
      folderId: "f2",
      tool: "codex",
      title: "fix checkout.spec timers",
      cliSessionId: "c8e2-1120-77af",
      status: "stopped",
      model: "gpt-5-codex",
      extraArgs: [],
      createdAt: now(),
      lastActiveAt: now(),
      wasOpenInTab: false,
    },
  ],
};

const settings: Settings = {
  shell: "/bin/zsh",
  envVars: [],
  autoRestore: true,
  confirmClose: true,
  stopOnClose: true,
  restoreScrollback: true,
  backupPath: "~/.anchor/sessions",
  retentionDays: 30,
  theme: "graphite",
  density: "comfortable",
  fontSize: 13,
  accent: "#d6417a",
  notifyOnWaiting: false,
};

type Listener = { event: string; handler: (payload: unknown) => void };
const listeners: Listener[] = [];

export function mockEmit(event: string, payload: unknown): void {
  for (const l of listeners) if (l.event === event) l.handler(payload);
}

export function mockListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const l: Listener = { event, handler: handler as Listener["handler"] };
  listeners.push(l);
  return Promise.resolve(() => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  });
}

export function mockInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (cmd) {
    case "get_state":
      return Promise.resolve(structuredClone(state) as T);
    case "get_settings":
      return Promise.resolve(structuredClone(settings) as T);
    case "set_settings":
      Object.assign(settings, (args as { settings: Settings }).settings);
      return Promise.resolve(structuredClone(settings) as T);
    case "detect_clis":
      return Promise.resolve(
        (["claude", "codex", "copilot", "opencode", "terminal"] as const).map(
          (tool) => ({ tool, found: true, version: "0.0.0-mock", path: `/mock/bin/${tool}` }),
        ) as T,
      );
    case "resume_session": {
      const s = state.sessions.find(
        (x) => x.id === (args as { sessionId: string }).sessionId,
      );
      if (!s) return Promise.reject("SESSION_NOT_FOUND: unknown id");
      s.status = "running";
      s.lastActiveAt = now();
      return Promise.resolve(structuredClone(s) as T);
    }
    default:
      // Phase 3 fleshes out the remaining commands as the UI needs them.
      return Promise.reject(`MOCK_NOT_IMPLEMENTED: ${cmd}`);
  }
}

export type { Session };
