import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    terminal: { options: { fontSize?: number } } | null = null;
    activate(terminal: { options: { fontSize?: number } }) {
      this.terminal = terminal;
    }
    fit() {}
    proposeDimensions() {
      return this.terminal?.options.fontSize === 16
        ? { cols: 110, rows: 33 }
        : { cols: 132, rows: 41 };
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
const terminalWrites: string[] = [];
const terminalSizesAtWrite: Array<{ cols: number; rows: number }> = [];
const terminalInstances: Array<{ cols: number; rows: number }> = [];
const terminalWriteCallbacks: Array<() => void> = [];
const terminalInputHandlers: Array<(data: string) => void> = [];
let deferTerminalWrites = false;
let terminalDisposeCalls = 0;
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      this.cols = typeof options.cols === "number" ? options.cols : 80;
      this.rows = typeof options.rows === "number" ? options.rows : 24;
      terminalInstances.push(this);
    }
    loadAddon(addon: { activate?: (terminal: unknown) => void }) {
      addon.activate?.(this);
    }
    onData(handler: (data: string) => void) {
      terminalInputHandlers.push(handler);
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    open() {}
    write(data: string, callback?: () => void) {
      if (data) {
        terminalWrites.push(data);
        terminalSizesAtWrite.push({ cols: this.cols, rows: this.rows });
      }
      if (!callback) return;
      if (deferTerminalWrites) terminalWriteCallbacks.push(callback);
      else callback();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    reset() {}
    focus() {}
    dispose() {
      terminalDisposeCalls += 1;
    }
  },
}));

const getStateMock = vi.fn();
const getSettingsMock = vi.fn();
const detectClisMock = vi.fn();
const frontendReadyMock = vi.fn();
const launchSessionMock = vi.fn();
const resumeSessionMock = vi.fn();
const repairSessionIdentityMock = vi.fn();
const forkCodexSessionMock = vi.fn();
const setTabOpenMock = vi.fn();
const stopSessionMock = vi.fn();
const deleteSessionMock = vi.fn();
const resizePtyMock = vi.fn();
const replayOutputMock = vi.fn();
const setSettingsMock = vi.fn();
const getCodexProfilesMock = vi.fn();
const setCodexProfileMock = vi.fn();
const setSessionIdMock = vi.fn();
const generateSessionTitleMock = vi.fn();
const writePtyMock = vi.fn();

vi.mock("../ipc/commands", () => ({
  ipc: {
    getState: (...a: unknown[]) => getStateMock(...a),
    getSettings: (...a: unknown[]) => getSettingsMock(...a),
    detectClis: (...a: unknown[]) => detectClisMock(...a),
    frontendReady: (...a: unknown[]) => frontendReadyMock(...a),
    launchSession: (...a: unknown[]) => launchSessionMock(...a),
    resumeSession: (...a: unknown[]) => resumeSessionMock(...a),
    repairSessionIdentity: (...a: unknown[]) => repairSessionIdentityMock(...a),
    forkCodexSession: (...a: unknown[]) => forkCodexSessionMock(...a),
    setTabOpen: (...a: unknown[]) => setTabOpenMock(...a),
    stopSession: (...a: unknown[]) => stopSessionMock(...a),
    deleteSession: (...a: unknown[]) => deleteSessionMock(...a),
    resizePty: (...a: unknown[]) => resizePtyMock(...a),
    replayOutput: (...a: unknown[]) => replayOutputMock(...a),
    setSettings: (...a: unknown[]) => setSettingsMock(...a),
    getCodexProfiles: (...a: unknown[]) => getCodexProfilesMock(...a),
    setCodexProfile: (...a: unknown[]) => setCodexProfileMock(...a),
    setSessionId: (...a: unknown[]) => setSessionIdMock(...a),
    generateSessionTitle: (...a: unknown[]) => generateSessionTitleMock(...a),
    writePty: (...a: unknown[]) => writePtyMock(...a),
  },
}));

const onPtyOutputMock = vi.fn();
const onSessionStatusMock = vi.fn();
const onSessionUpdatedMock = vi.fn();
const onSessionResumeErrorMock = vi.fn();
const onAttentionCountMock = vi.fn();
let ptyOutputHandler: ((payload: {
  sessionId: string;
  data: string;
  sequence: number;
  gridEpoch: number;
  cols: number;
  rows: number;
}) => void) | null;
let sessionStatusHandler: ((payload: { sessionId: string; status: Session["status"]; exitCode: number | null }) => void) | null;
let sessionUpdatedHandler: ((session: Session) => void) | null;
let sessionResumeErrorHandler: ((payload: { sessionId: string; code: string; message: string }) => void) | null;

vi.mock("../ipc/events", () => ({
  onPtyOutput: (...a: unknown[]) => onPtyOutputMock(...a),
  onSessionStatus: (...a: unknown[]) => onSessionStatusMock(...a),
  onSessionUpdated: (...a: unknown[]) => onSessionUpdatedMock(...a),
  onSessionResumeError: (...a: unknown[]) => onSessionResumeErrorMock(...a),
  onAttentionCount: (...a: unknown[]) => onAttentionCountMock(...a),
}));

import type { Folder, Session, Settings, TerminalSize } from "../ipc/types";
import App from "../App";
import { AnchorProvider } from "./store";
import { DEFAULT_TERMINAL_THEME, DEFAULT_WORKSPACE } from "./workspaces";

const SETTINGS: Settings = {
  shell: "/bin/zsh",
  envVars: [],
  autoRestore: true,
  confirmClose: true,
  stopOnClose: true,
  restoreScrollback: false,
  backupPath: "~/.anchor/sessions",
  projectsDir: "~/Documents/Anchor/Projects",
  retentionDays: 30,
  theme: "graphite",
  density: "comfortable",
  fontSize: 13,
  accent: "#88a99d",
  notifyOnWaiting: false,
  responseReadDelayMs: 1000,
  favoriteSessionIds: [],
  folderOrder: [],
  tabOrder: [],
  emptyFolderSinceMs: {},
  workspaces: [DEFAULT_WORKSPACE],
  activeWorkspaceId: DEFAULT_WORKSPACE.id,
  sessionWorkspaceIds: {},
  workspacePaneKeepOpen: false,
  terminalTheme: DEFAULT_TERMINAL_THEME,
  customHarnesses: [],
  sessionHarnessIds: {},
};

const FOLDER: Folder = { id: "folder-1", name: "synthetic", path: "~/synthetic" };

function runningSession(id: string): Session {
  return {
    id,
    folderId: FOLDER.id,
    tool: "terminal",
    title: id,
    cliSessionId: null,
    status: "running",
    model: null,
    extraArgs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    wasOpenInTab: true,
    codexProfile: null,
  };
}

function stoppedAiSession(id: string, cliSessionId: string | null): Session {
  return {
    ...runningSession(id),
    tool: "codex",
    status: "stopped",
    cliSessionId,
  };
}

function runningAiSession(id: string): Session {
  return {
    ...runningSession(id),
    tool: "codex",
    cliSessionId: `${id}-provider`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  terminalWrites.length = 0;
  terminalSizesAtWrite.length = 0;
  terminalInstances.length = 0;
  terminalWriteCallbacks.length = 0;
  terminalInputHandlers.length = 0;
  deferTerminalWrites = false;
  terminalDisposeCalls = 0;
  ptyOutputHandler = null;
  sessionStatusHandler = null;
  sessionUpdatedHandler = null;
  sessionResumeErrorHandler = null;

  onPtyOutputMock.mockImplementation(async (handler) => {
    ptyOutputHandler = handler;
    return () => {};
  });
  onSessionStatusMock.mockImplementation(async (handler) => {
    sessionStatusHandler = handler;
    return () => {};
  });
  onSessionUpdatedMock.mockImplementation(async (handler) => {
    sessionUpdatedHandler = handler;
    return () => {};
  });
  onSessionResumeErrorMock.mockImplementation(async (handler) => {
    sessionResumeErrorHandler = handler;
    return () => {};
  });
  onAttentionCountMock.mockImplementation(async () => () => {});

  getStateMock.mockImplementation(async () => ({ folders: [], sessions: [] }));
  getSettingsMock.mockImplementation(async () => ({ ...SETTINGS }));
  detectClisMock.mockImplementation(async () => []);
  frontendReadyMock.mockImplementation(async (size) => size);
  launchSessionMock.mockResolvedValue(undefined);
  resumeSessionMock.mockResolvedValue(undefined);
  repairSessionIdentityMock.mockResolvedValue(undefined);
  forkCodexSessionMock.mockResolvedValue(undefined);
  setTabOpenMock.mockResolvedValue(undefined);
  stopSessionMock.mockResolvedValue(undefined);
  deleteSessionMock.mockResolvedValue(undefined);
  resizePtyMock.mockResolvedValue({ throughSequence: 0, gridEpoch: 2 });
  replayOutputMock.mockResolvedValue({
    data: "",
    throughSequence: 0,
    cols: 132,
    rows: 41,
    coversUnsequenced: false,
    gridEpoch: 1,
  });
  setSettingsMock.mockImplementation(async (settings: Settings) => settings);
  getCodexProfilesMock.mockResolvedValue([]);
  setCodexProfileMock.mockResolvedValue(undefined);
  setSessionIdMock.mockResolvedValue(undefined);
  generateSessionTitleMock.mockResolvedValue(undefined);
  writePtyMock.mockResolvedValue(undefined);

  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AnchorProvider boot order", () => {
  it("subscribes to PTY events before requesting state and starting restore", async () => {
    const order: string[] = [];
    onPtyOutputMock.mockImplementation(async () => {
      order.push("listen-output");
      return () => {};
    });
    onSessionStatusMock.mockImplementation(async () => {
      order.push("listen-status");
      return () => {};
    });
    getStateMock.mockImplementation(async () => {
      order.push("get-state");
      return { folders: [], sessions: [] };
    });
    frontendReadyMock.mockImplementation(async (size) => {
      order.push("frontend-ready");
      return size;
    });

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );
    await waitFor(() => expect(order).toContain("frontend-ready"));

    expect(order.indexOf("listen-output")).toBeLessThan(order.indexOf("get-state"));
    expect(order.indexOf("listen-status")).toBeLessThan(order.indexOf("get-state"));
    expect(order.indexOf("get-state")).toBeLessThan(order.indexOf("frontend-ready"));
  });

  it("signals frontend readiness exactly once per boot", async () => {
    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );
    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalledTimes(1));
    expect(frontendReadyMock).toHaveBeenCalledWith({ cols: 132, rows: 41 });
  });

  it("does not overwrite a subscribed stop event with an older state snapshot", async () => {
    const settings = deferred<Settings>();
    getStateMock
      .mockResolvedValueOnce({ folders: [FOLDER], sessions: [runningSession("alpha")] })
      .mockResolvedValue({
        folders: [FOLDER],
        sessions: [{ ...runningSession("alpha"), status: "stopped" }],
      });
    getSettingsMock.mockReturnValue(settings.promise);

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );
    await waitFor(() => expect(sessionStatusHandler).not.toBeNull());
    sessionStatusHandler?.({ sessionId: "alpha", status: "stopped", exitCode: 0 });
    settings.resolve({ ...SETTINGS });

    expect(await screen.findByRole("button", { name: /resume session/i })).toBeInTheDocument();
    expect(replayOutputMock).not.toHaveBeenCalled();
  });

  it("measures auto-restore with the saved terminal font", async () => {
    getSettingsMock.mockResolvedValue({ ...SETTINGS, fontSize: 16 });

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalledTimes(1));
    expect(frontendReadyMock).toHaveBeenCalledWith({ cols: 110, rows: 33 });
  });

  it("prepares auto-restored sessions at the live PTY grid returned by replay", async () => {
    const stopped = stoppedAiSession("codex-session", "synthetic-session-id");
    getStateMock
      .mockResolvedValueOnce({ folders: [FOLDER], sessions: [stopped] })
      .mockResolvedValue({
        folders: [FOLDER],
        sessions: [{ ...stopped, status: "running" }],
      });
    // Model a command response that arrives before Tauri delivers the final
    // running event. The post-handshake state read must still select replay.
    frontendReadyMock.mockResolvedValue({ cols: 132, rows: 41 });
    replayOutputMock.mockResolvedValue({
      data: "restored frame",
      throughSequence: 1,
      cols: 100,
      rows: 30,
      coversUnsequenced: false,
      gridEpoch: 1,
    });

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalledWith({ cols: 132, rows: 41 }));
    expect(terminalSizesAtWrite).toContainEqual({ cols: 100, rows: 30 });
  });

  it("does not mount a live session slot before its restore snapshot is ready", async () => {
    const ready = deferred<TerminalSize>();
    getStateMock.mockResolvedValue({ folders: [FOLDER], sessions: [runningSession("alpha")] });
    frontendReadyMock.mockReturnValue(ready.promise);

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalled());
    expect(terminalInstances).toHaveLength(1);

    ready.resolve({ cols: 132, rows: 41 });
    await waitFor(() => expect(terminalInstances).toHaveLength(2));
  });

  it("waits for xterm to parse replay before mounting and fitting the live slot", async () => {
    deferTerminalWrites = true;
    getStateMock.mockResolvedValue({ folders: [FOLDER], sessions: [runningSession("alpha")] });
    replayOutputMock.mockResolvedValue({
      data: "large TUI snapshot",
      throughSequence: 1,
      cols: 100,
      rows: 30,
      coversUnsequenced: false,
      gridEpoch: 1,
    });

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    await waitFor(() => expect(terminalWriteCallbacks).toHaveLength(1));
    expect(document.querySelector("[data-terminal-session-id='alpha']")).toBeNull();
    expect(terminalInstances[terminalInstances.length - 1]).toMatchObject({ cols: 100, rows: 30 });

    terminalWriteCallbacks.shift()?.();
    await waitFor(() => expect(terminalWriteCallbacks).toHaveLength(1));
    expect(document.querySelector("[data-terminal-session-id='alpha']")).toBeNull();

    terminalWriteCallbacks.shift()?.();
    await waitFor(() =>
      expect(document.querySelector("[data-terminal-session-id='alpha']")).not.toBeNull(),
    );
  });

  it("blocks a new launch while the boot restore handshake is pending", async () => {
    const ready = deferred<TerminalSize>();
    getStateMock.mockResolvedValue({ folders: [FOLDER], sessions: [] });
    frontendReadyMock.mockReturnValue(ready.promise);

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New session" }));
    fireEvent.click(within(document.querySelector(".a-modal")!).getByRole("button", { name: /synthetic/i }));
    fireEvent.click(screen.getByRole("button", { name: /Codex$/ }));

    expect(launchSessionMock).not.toHaveBeenCalled();
    expect(screen.getByText("Anchor is still restoring sessions.")).toBeInTheDocument();
  });

  it("removes sessions absent from the authoritative post-restore state", async () => {
    const finalState = deferred<{ folders: Folder[]; sessions: Session[] }>();
    const replay = deferred<{
      data: string;
      throughSequence: number;
      cols: number;
      rows: number;
      coversUnsequenced: boolean;
      gridEpoch: number;
    }>();
    getStateMock
      .mockResolvedValueOnce({
        folders: [FOLDER],
        sessions: [runningSession("alpha"), runningSession("removed")],
      })
      .mockReturnValue(finalState.promise);
    replayOutputMock.mockReturnValue(replay.promise);

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      sessionUpdatedHandler?.({
        ...runningSession("ghost-never-in-state"),
        title: "ghost during final state read",
      });
    });
    finalState.resolve({ folders: [FOLDER], sessions: [runningSession("alpha")] });
    await waitFor(() => expect(replayOutputMock).toHaveBeenCalledWith("alpha"));
    ptyOutputHandler?.({
      sessionId: "removed",
      data: "late deleted output",
      sequence: 1,
      gridEpoch: 1,
      cols: 132,
      rows: 41,
    });
    ptyOutputHandler?.({
      sessionId: "ghost-never-in-state",
      data: "late ghost output",
      sequence: 1,
      gridEpoch: 1,
      cols: 132,
      rows: 41,
    });
    await act(async () => {
      sessionUpdatedHandler?.({
        ...runningSession("ghost-never-in-state"),
        title: "late ghost domain update",
      });
    });
    replay.resolve({
      data: "alpha snapshot",
      throughSequence: 0,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    });
    await waitFor(() =>
      expect(screen.queryByText("removed", { selector: ".a-tab__title" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(terminalInstances).toHaveLength(2));
    expect(screen.queryByText("late ghost domain update")).toBeNull();
    expect(screen.queryByText("ghost during final state read")).toBeNull();
  });
});

describe("recovering terminals after a page reload", () => {
  function bootWith(sessions: Session[], strict = false) {
    getStateMock.mockImplementation(async () => ({ folders: [FOLDER], sessions }));
    const tree = (
      <AnchorProvider>
        <App />
      </AnchorProvider>
    );
    return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  }

  it("asks the core to resend output for every session already live at boot", async () => {
    // The reload wiped their xterm buffers; the PTYs kept running.
    bootWith([runningSession("alpha"), runningSession("beta")]);

    await waitFor(() => expect(replayOutputMock).toHaveBeenCalledTimes(2));
    expect(replayOutputMock.mock.calls.map(([id]) => id).sort()).toEqual(["alpha", "beta"]);
  });

  it("does not replay sessions that are not running", async () => {
    // A stopped session is prepared for auto-restore but has no live snapshot.
    bootWith([{ ...runningSession("alpha"), status: "stopped" }]);

    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalled());
    expect(replayOutputMock).not.toHaveBeenCalled();
  });

  it("replays a session once under StrictMode's doubled effects", async () => {
    // Replaying twice would print the session's whole history twice over.
    bootWith([runningSession("alpha")], true);

    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalled());
    await waitFor(() => expect(replayOutputMock).toHaveBeenCalledTimes(1));
    expect(replayOutputMock).toHaveBeenCalledTimes(1);
  });

  it("reconstructs subscribed output once across the replay boundary", async () => {
    const state = deferred<{ folders: Folder[]; sessions: Session[] }>();
    const replay = deferred<{
      data: string;
      throughSequence: number;
      cols: number;
      rows: number;
      coversUnsequenced: boolean;
      gridEpoch: number;
    }>();
    getStateMock.mockReturnValue(state.promise);
    replayOutputMock.mockReturnValue(replay.promise);
    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );
    await waitFor(() => expect(ptyOutputHandler).not.toBeNull());

    ptyOutputHandler?.({
      sessionId: "alpha",
      data: "A",
      sequence: 1,
      gridEpoch: 1,
      cols: 132,
      rows: 41,
    });
    state.resolve({ folders: [FOLDER], sessions: [runningSession("alpha")] });
    await waitFor(() => expect(replayOutputMock).toHaveBeenCalledWith("alpha"));
    ptyOutputHandler?.({
      sessionId: "alpha",
      data: "B",
      sequence: 2,
      gridEpoch: 1,
      cols: 132,
      rows: 41,
    });
    replay.resolve({
      data: "history-A",
      throughSequence: 1,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    });

    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalled());
    expect(terminalWrites.join("")).toBe("history-AB");
  });

  it("uses the backend's one authoritative terminal replay", async () => {
    getSettingsMock.mockResolvedValue({ ...SETTINGS, restoreScrollback: true });
    getStateMock.mockResolvedValue({ folders: [FOLDER], sessions: [runningSession("alpha")] });
    replayOutputMock.mockResolvedValue({
      data: "old line\nlive output\n── restored session · scrollback recovered (2 lines) ──\n",
      throughSequence: 2,
      cols: 132,
      rows: 41,
      coversUnsequenced: true,
      gridEpoch: 1,
    });

    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalled());
    expect(terminalWrites.join("")).toBe(
      "old line\nlive output\n── restored session · scrollback recovered (2 lines) ──\n",
    );
  });
});

async function renderRunningSessionApp(
  ids: string[] = ["synthetic-session"],
  settings: Partial<Settings> = {},
) {
  // Default the confirmation off so the close-latency tests below measure the
  // close itself; the confirmation has its own describe block.
  getSettingsMock.mockImplementation(async () => ({
    ...SETTINGS,
    confirmClose: false,
    ...settings,
  }));
  getStateMock.mockImplementation(async () => ({
    folders: [FOLDER],
    sessions: ids.map(runningSession),
  }));

  const view = render(
    <AnchorProvider>
      <App />
    </AnchorProvider>,
  );
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Close tab" })).toHaveLength(ids.length),
  );
  return view;
}

describe("closeTab", () => {
  it("closes immediately and sends one backend-owned close request", async () => {
    const close = deferred<void>();
    setTabOpenMock.mockReturnValue(close.promise);
    await renderRunningSessionApp();

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(screen.queryByRole("button", { name: "Close tab" })).not.toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledTimes(1);
    expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
    expect(stopSessionMock).not.toHaveBeenCalled();

    // The window stays interactive while backend shutdown is still pending.
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByText("General", { selector: ".settings__h" })).toBeInTheDocument();
    close.resolve();
  });

  it("selects the adjacent tab without waiting for the close request", async () => {
    const close = deferred<void>();
    setTabOpenMock.mockReturnValue(close.promise);
    await renderRunningSessionApp(["session-a", "session-b"]);

    const closeButtons = screen.getAllByRole("button", { name: "Close tab" });
    expect(closeButtons).toHaveLength(2);
    fireEvent.click(closeButtons[0]);

    const visible = document.querySelectorAll('[data-terminal-active="true"]');
    expect(visible).toHaveLength(1);
    expect(visible[0]).toHaveAttribute("data-terminal-session-id", "session-b");
    close.resolve();
  });

  it("restores the tab when the close request fails", async () => {
    const close = deferred<void>();
    setTabOpenMock.mockReturnValue(close.promise);
    await renderRunningSessionApp();

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    expect(screen.queryByRole("button", { name: "Close tab" })).not.toBeInTheDocument();

    close.reject(new Error("TAB_PERSIST_FAILED: registry write failed"));

    await screen.findByRole("button", { name: "Close tab" });
  });

  it("keeps a tab reopened during shutdown alive", async () => {
    const close = deferred<void>();
    setTabOpenMock.mockReturnValue(close.promise);
    await renderRunningSessionApp();

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    // Reselecting before shutdown settles reopens the tab; the in-flight close
    // must not then dispose its terminal.
    fireEvent.click(screen.getByText("synthetic-session", { selector: ".a-row__title" }));
    await screen.findByRole("button", { name: "Close tab" });

    close.resolve();

    await waitFor(() =>
      expect(document.querySelectorAll("[data-terminal-session-id]")).toHaveLength(1),
    );
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
  });
});

describe("tab ordering", () => {
  it("restores the persisted order", async () => {
    await renderRunningSessionApp(["session-a", "session-b", "session-c"], {
      tabOrder: ["session-c", "session-a"],
    });

    const titles = Array.from(document.querySelectorAll(".a-tab__title"))
      .map((element) => element.textContent);
    expect(titles).toEqual(["session-c", "session-a", "session-b"]);
  });

  it("reorders tabs by drag and persists the result without changing the active tab", async () => {
    await renderRunningSessionApp(["session-a", "session-b", "session-c"]);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>(".a-tab"));
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
    };
    vi.spyOn(tabs[2], "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 230,
      top: 0,
      bottom: 36,
      width: 230,
      height: 36,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.dragStart(tabs[0], { dataTransfer });
    const dragOver = createEvent.dragOver(tabs[2], { dataTransfer });
    Object.defineProperty(dragOver, "clientX", { value: 200 });
    fireEvent(tabs[2], dragOver);
    expect(tabs[2]).toHaveAttribute("data-drop", "after");
    const drop = createEvent.drop(tabs[2], { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: 200 });
    fireEvent(tabs[2], drop);

    await waitFor(() => expect(setSettingsMock).toHaveBeenCalled());
    const titles = Array.from(document.querySelectorAll(".a-tab__title"))
      .map((element) => element.textContent);
    expect(titles).toEqual(["session-b", "session-c", "session-a"]);
    const [saved] = setSettingsMock.mock.calls[setSettingsMock.mock.calls.length - 1] as [Settings];
    expect(saved.tabOrder).toEqual(["session-b", "session-c", "session-a"]);
    expect(document.querySelector('[data-terminal-active="true"]')).toHaveAttribute(
      "data-terminal-session-id",
      "session-a",
    );
  });
});

describe("sidebar folder groups", () => {
  it("hides the path and collapse marker while the folder name toggles its sessions", async () => {
    const view = await renderRunningSessionApp();

    expect(view.container.querySelector(".folder__chevron")).toBeNull();
    const folderName = screen.getByRole("button", { name: FOLDER.name });
    expect(folderName.closest(".folder")).not.toHaveTextContent(FOLDER.path);
    expect(folderName).toHaveAttribute("aria-expanded", "true");
    expect(getComputedStyle(folderName).fontWeight).toBe("normal");

    fireEvent.click(folderName);

    expect(folderName).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("synthetic-session", { selector: ".a-row__title" })).toBeNull();
  });

  it("opens the session options menu on right-click", async () => {
    await renderRunningSessionApp();
    const row = screen.getByText("synthetic-session", { selector: ".a-row__title" }).closest(".a-row")!;

    fireEvent.contextMenu(row);

    expect(screen.getByRole("button", { name: /Rename session$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy session ID$/ })).toBeInTheDocument();
  });

  it("uses a neutral sidebar action to close an open tab without confirmation", async () => {
    getSettingsMock.mockResolvedValue({ ...SETTINGS, confirmClose: true, stopOnClose: true });
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [runningAiSession("synthetic-session")],
    }));
    render(<AnchorProvider><App /></AnchorProvider>);
    await waitFor(() => expect(terminalInputHandlers).toHaveLength(1));

    await act(async () => {
      terminalInputHandlers[0]("do work\r");
      await Promise.resolve();
    });

    const row = screen.getByText("synthetic-session", { selector: ".folder__sessions .a-row__title" }).closest<HTMLElement>(".a-row")!;
    fireEvent.mouseEnter(row);
    const closeFromSidebar = within(row).getByRole("button", { name: "Close tab from sidebar" });
    expect(closeFromSidebar).not.toHaveClass("a-iconbtn--danger");
    expect(within(row).queryByRole("button", { name: "Delete session" })).not.toBeInTheDocument();

    fireEvent.click(closeFromSidebar);

    expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Delete session" })).toBeInTheDocument();
  });

  it("reorders sessions only after submitted input", async () => {
    await renderRunningSessionApp(["session-a", "session-b"]);
    const sidebarOrder = () => Array.from(document.querySelectorAll(".folder__sessions .a-row__title"))
      .map((element) => element.textContent);

    expect(sidebarOrder()).toEqual(["session-a", "session-b"]);
    fireEvent.click(screen.getByText("session-b", { selector: ".folder__sessions .a-row__title" }));
    expect(sidebarOrder()).toEqual(["session-a", "session-b"]);

    act(() => terminalInputHandlers[1]?.("draft"));
    expect(sidebarOrder()).toEqual(["session-a", "session-b"]);
    act(() => terminalInputHandlers[1]?.("\r"));
    await waitFor(() => expect(sidebarOrder()).toEqual(["session-b", "session-a"]));
    expect(writePtyMock).toHaveBeenCalledWith("session-b", "\r");
  });

  it("does not reorder when the submitted PTY write fails", async () => {
    writePtyMock.mockRejectedValue(new Error("synthetic write failure"));
    await renderRunningSessionApp(["session-a", "session-b"]);
    const sidebarOrder = () => Array.from(document.querySelectorAll(".folder__sessions .a-row__title"))
      .map((element) => element.textContent);

    await act(async () => {
      terminalInputHandlers[1]("unsent message\r");
      await Promise.resolve();
    });
    expect(sidebarOrder()).toEqual(["session-a", "session-b"]);
  });

  it("shows blue only for completed background responses and clears it after the read delay", async () => {
    const closed = { ...runningAiSession("closed-session"), wasOpenInTab: false };
    generateSessionTitleMock.mockImplementation(async (id: string) => runningAiSession(id));
    getSettingsMock.mockResolvedValue({ ...SETTINGS, confirmClose: false });
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [runningAiSession("session-a"), runningAiSession("session-b"), closed],
    }));
    render(<AnchorProvider><App /></AnchorProvider>);
    await waitFor(() => expect(terminalInputHandlers).toHaveLength(3));

    const firstTab = screen.getByText("session-a", { selector: ".a-tab__title" }).closest<HTMLElement>(".a-tab")!;
    expect(firstTab.querySelector(".a-dot")).toBeNull();

    await act(async () => {
      terminalInputHandlers[0]("do work\r");
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("session-b", { selector: ".a-tab__title" }));
    act(() => sessionStatusHandler?.({ sessionId: "session-a", status: "waiting", exitCode: null }));

    const firstSidebarRow = screen.getByText("session-a", { selector: ".folder__sessions .a-row__title" }).closest<HTMLElement>(".a-row")!;
    const closedSidebarRow = screen.getByText("closed-session", { selector: ".folder__sessions .a-row__title" }).closest<HTMLElement>(".a-row")!;
    expect(within(firstTab).getByLabelText("AI response ready")).toBeInTheDocument();
    expect(within(firstSidebarRow).getByLabelText("AI response ready")).toBeInTheDocument();
    expect(closedSidebarRow.querySelector(".a-dot")).toBeNull();

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByText("session-a", { selector: ".a-tab__title" }));
      act(() => vi.advanceTimersByTime(500));
      fireEvent.click(screen.getByText("session-b", { selector: ".a-tab__title" }));
      act(() => vi.advanceTimersByTime(1000));
      expect(within(firstSidebarRow).getByLabelText("AI response ready")).toBeInTheDocument();
      fireEvent.click(screen.getByText("session-a", { selector: ".a-tab__title" }));
      act(() => vi.advanceTimersByTime(1000));
      expect(within(firstSidebarRow).getByLabelText("Open chat")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unread response blue when closing another tab selects it automatically", async () => {
    generateSessionTitleMock.mockImplementation(async (id: string) => runningAiSession(id));
    getSettingsMock.mockResolvedValue({ ...SETTINGS, confirmClose: false });
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [runningAiSession("session-a"), runningAiSession("session-b")],
    }));
    render(<AnchorProvider><App /></AnchorProvider>);
    await waitFor(() => expect(terminalInputHandlers).toHaveLength(2));

    await act(async () => {
      terminalInputHandlers[0]("do work\r");
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("session-b", { selector: ".a-tab__title" }));
    act(() => sessionStatusHandler?.({ sessionId: "session-a", status: "waiting", exitCode: null }));

    const firstSidebarRow = screen.getByText("session-a", { selector: ".folder__sessions .a-row__title" }).closest<HTMLElement>(".a-row")!;
    expect(within(firstSidebarRow).getByLabelText("AI response ready")).toBeInTheDocument();

    vi.useFakeTimers();
    try {
      const secondTab = screen.getByText("session-b", { selector: ".a-tab__title" }).closest<HTMLElement>(".a-tab")!;
      fireEvent.click(within(secondTab).getByRole("button", { name: "Close tab" }));
      act(() => vi.advanceTimersByTime(5000));
      expect(within(firstSidebarRow).getByLabelText("AI response ready")).toBeInTheDocument();

      // Clicking the already visible tab is still an explicit read action.
      fireEvent.click(screen.getByText("session-a", { selector: ".a-tab__title" }));
      act(() => vi.advanceTimersByTime(1000));
      expect(within(firstSidebarRow).getByLabelText("Open chat")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a chat to Favorites without removing it from All chats", async () => {
    await renderRunningSessionApp();
    const row = screen.getByText("synthetic-session", { selector: ".folder__sessions .a-row__title" }).closest(".a-row")!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: /Add to favorites/ }));

    await waitFor(() => expect(setSettingsMock).toHaveBeenCalled());
    expect(document.querySelector(".sidebar__favorites .a-row__title")).toHaveTextContent("synthetic-session");
    expect(screen.getAllByText("synthetic-session", { selector: ".a-row__title" })).toHaveLength(2);
  });

  it("persists folder drag order", async () => {
    const secondFolder: Folder = { id: "folder-2", name: "second synthetic", path: "~/second" };
    getSettingsMock.mockResolvedValue({ ...SETTINGS, confirmClose: false });
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER, secondFolder],
      sessions: [runningSession("session-a"), { ...runningSession("session-b"), folderId: secondFolder.id }],
    }));
    render(<AnchorProvider><App /></AnchorProvider>);
    await screen.findByRole("button", { name: secondFolder.name });

    const source = screen.getByRole("button", { name: secondFolder.name }).closest(".folder")!;
    const target = screen.getByRole("button", { name: FOLDER.name }).closest(".folder")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 20, width: 200, height: 20,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => secondFolder.id),
    };
    fireEvent.dragStart(source.querySelector(".folder__head")!, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 1 });
    fireEvent.drop(target, { dataTransfer, clientY: 1 });

    await waitFor(() => expect(setSettingsMock).toHaveBeenCalled());
    const saved = setSettingsMock.mock.calls[setSettingsMock.mock.calls.length - 1][0] as Settings;
    expect(saved.folderOrder).toEqual([secondFolder.id, FOLDER.id]);
  });

  it("keeps a folder visible for 12 hours after it becomes empty", async () => {
    getStateMock.mockResolvedValue({ folders: [FOLDER], sessions: [] });
    render(<AnchorProvider><App /></AnchorProvider>);

    const folderName = await screen.findByRole("button", { name: FOLDER.name });
    expect(folderName).toBeInTheDocument();
    await waitFor(() => expect(setSettingsMock).toHaveBeenCalled());
    const saved = setSettingsMock.mock.calls[setSettingsMock.mock.calls.length - 1][0] as Settings;
    expect(saved.emptyFolderSinceMs[FOLDER.id]).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Hidden/ })).toBeNull();
  });

  it("collapses empty folders older than 12 hours into a gray Hidden group", async () => {
    const oldEmptyFolder: Folder = { id: "folder-2", name: "archived synthetic", path: "~/archived" };
    getSettingsMock.mockResolvedValue({
      ...SETTINGS,
      emptyFolderSinceMs: { [oldEmptyFolder.id]: Date.now() - 12 * 60 * 60 * 1000 },
    });
    getStateMock.mockResolvedValue({
      folders: [FOLDER, oldEmptyFolder],
      sessions: [runningSession("synthetic-session")],
    });
    render(<AnchorProvider><App /></AnchorProvider>);

    const hiddenToggle = await screen.findByRole("button", { name: /Hidden/ });
    expect(hiddenToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: oldEmptyFolder.name })).toBeNull();

    fireEvent.click(hiddenToggle);

    expect(hiddenToggle).toHaveAttribute("aria-expanded", "true");
    const hiddenFolderName = screen.getByRole("button", { name: oldEmptyFolder.name });
    expect(hiddenFolderName.closest(".folder")).toHaveClass("folder--hidden");
  });
});

describe("new-session folder chooser", () => {
  it("shows Add a folder before folders already in Anchor", async () => {
    await renderRunningSessionApp();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    const modal = document.querySelector(".a-modal")!;
    const labels = Array.from(modal.querySelectorAll(".nt__label")).map((label) => label.textContent);
    expect(labels.slice(0, 2)).toEqual(["Add a folder", "Folders already in Anchor"]);
  });
});

describe("settings exposure", () => {
  it("shows the packaged app version", async () => {
    await renderRunningSessionApp();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));

    expect(screen.getByText("Anchor v0.2.0")).toBeInTheDocument();
  });

  it("lets the user turn on waiting notifications", async () => {
    // The backend already gates its OS notification on notifyOnWaiting, but for
    // a while nothing in Settings could change it, so it was stuck off forever.
    await renderRunningSessionApp();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));

    const toggle = screen.getByRole("switch", { name: "Notify when a session needs attention" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);

    await waitFor(() => expect(setSettingsMock).toHaveBeenCalled());
    const calls = setSettingsMock.mock.calls;
    const [patch] = calls[calls.length - 1] as [Settings];
    expect(patch.notifyOnWaiting).toBe(true);
  });

  it("lets the user set the response read delay", async () => {
    await renderRunningSessionApp();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("radio", { name: "2.5 seconds" }));

    await waitFor(() => expect(setSettingsMock).toHaveBeenCalled());
    const saved = setSettingsMock.mock.calls[setSettingsMock.mock.calls.length - 1][0] as Settings;
    expect(saved.responseReadDelayMs).toBe(2500);
  });
});

describe("launch and resume failures", () => {
  async function renderStoppedAiSession(cliSessionId: string | null, stopOnClose = true) {
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [stoppedAiSession("codex-session", cliSessionId)],
    }));
    getSettingsMock.mockImplementation(async () => ({
      ...SETTINGS,
      confirmClose: false,
      stopOnClose,
    }));
    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );
    const resume = await screen.findByRole("button", { name: /resume session|start new chat in this session/i });
    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalled());
    if (cliSessionId) await waitFor(() => expect(resume).toBeEnabled());
  }

  it("starts a new provider chat inside the existing record when its ID is missing", async () => {
    repairSessionIdentityMock.mockResolvedValue({
      ...stoppedAiSession("codex-session", "synthetic-repaired-id"),
      status: "running",
    });
    await renderStoppedAiSession(null);

    expect(screen.getByText("Unavailable", { selector: ".resume-card__grid .v" })).toBeInTheDocument();
    expect(screen.getByText(/inside this existing session/i)).toBeInTheDocument();
    const repair = screen.getByRole("button", { name: /start new chat in this session/i });

    fireEvent.click(repair);
    await waitFor(() => expect(repairSessionIdentityMock).toHaveBeenCalledWith(
      "codex-session",
      { cols: 132, rows: 41 },
    ));
    expect(resumeSessionMock).not.toHaveBeenCalled();
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  it("sets a provider session ID from the stopped-session context menu", async () => {
    const updated = stoppedAiSession("codex-session", "manual-synthetic-id");
    setSessionIdMock.mockResolvedValue(updated);
    await renderStoppedAiSession("old-synthetic-id");

    const row = screen.getByText("codex-session", { selector: ".a-row__title" }).closest<HTMLElement>(".a-row")!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: /Set session ID/ }));
    const input = screen.getByRole("textbox", { name: "Provider session ID" });
    fireEvent.change(input, { target: { value: "manual-synthetic-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Save session ID" }));

    await waitFor(() => expect(setSessionIdMock).toHaveBeenCalledWith(
      "codex-session",
      "manual-synthetic-id",
    ));
    expect(screen.queryByText("Set session ID", { selector: ".dialog__title" })).not.toBeInTheDocument();
  });

  it("accepts late identity discovery for a stopped boot session", async () => {
    await renderStoppedAiSession(null);
    const discovered = stoppedAiSession("codex-session", "synthetic-discovered-id");
    resumeSessionMock.mockResolvedValue({ ...discovered, status: "running" });

    await act(async () => {
      sessionUpdatedHandler?.(discovered);
    });
    const resume = screen.getByRole("button", { name: /resume session/i });
    expect(resume).toBeEnabled();
    fireEvent.click(resume);

    await waitFor(() =>
      expect(resumeSessionMock).toHaveBeenCalledWith("codex-session", { cols: 132, rows: 41 })
    );
  });

  it("keeps a resume failure in the card and explains how to recover a missing CLI", async () => {
    resumeSessionMock.mockRejectedValue("CLI_NOT_FOUND: Codex is not installed");
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));

    const error = await screen.findByRole("alert");
    expect(resumeSessionMock).toHaveBeenCalledWith("codex-session", { cols: 132, rows: 41 });
    expect(error).toHaveTextContent("Codex is not installed");
    expect(error).toHaveTextContent("Install codex and ensure it is available on PATH");
    expect(screen.getByRole("button", { name: /start fresh session in this folder/i })).toBeInTheDocument();
  });

  it("turns a Codex active-writer rejection into a safe fork action", async () => {
    const source = stoppedAiSession("codex-session", "synthetic-session-id");
    resumeSessionMock.mockResolvedValue({ ...source, status: "running" });
    const forked = {
      ...stoppedAiSession("forked-session", "synthetic-fork-id"),
      title: "codex-session (fork)",
      status: "running" as const,
    };
    forkCodexSessionMock.mockResolvedValue(forked);
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      sessionResumeErrorHandler?.({
        sessionId: "codex-session",
        code: "CODEX_ACTIVE_WRITER",
        message: "This Codex conversation is already open in another Codex session.",
      });
      sessionStatusHandler?.({ sessionId: "codex-session", status: "stopped", exitCode: 1 });
    });

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("already open in another Codex session");
    expect(error).toHaveTextContent("Forking preserves the transcript under a new session ID");
    fireEvent.click(screen.getByRole("button", { name: /fork conversation and continue/i }));

    await waitFor(() =>
      expect(forkCodexSessionMock).toHaveBeenCalledWith("codex-session", { cols: 132, rows: 41 }),
    );
    expect(await screen.findByText("codex-session (fork)", { selector: ".a-row__title" })).toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledWith("forked-session", true);
  });

  it("deduplicates concurrent resume actions for one session", async () => {
    const resume = deferred<Session>();
    resumeSessionMock.mockReturnValue(resume.promise);
    await renderStoppedAiSession("synthetic-session-id");
    const button = screen.getByRole("button", { name: /resume session/i });

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    resume.resolve({
      ...stoppedAiSession("codex-session", "synthetic-session-id"),
      status: "running",
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /resume session/i })).not.toBeInTheDocument());
  });

  it("closes only after an already-sent resume IPC settles", async () => {
    const resume = deferred<Session>();
    resumeSessionMock.mockReturnValue(resume.promise);
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(setTabOpenMock).not.toHaveBeenCalledWith("codex-session", false);

    resume.resolve({
      ...stoppedAiSession("codex-session", "synthetic-session-id"),
      status: "running",
    });
    await waitFor(() => expect(setTabOpenMock).toHaveBeenCalledWith("codex-session", false));
  });

  it("retains the terminal when a pending resume finishes with stop-on-close disabled", async () => {
    const resume = deferred<Session>();
    resumeSessionMock.mockReturnValue(resume.promise);
    await renderStoppedAiSession("synthetic-session-id", false);

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    resume.resolve({
      ...stoppedAiSession("codex-session", "synthetic-session-id"),
      status: "running",
    });

    await waitFor(() => expect(setTabOpenMock).toHaveBeenCalledWith("codex-session", false));
    expect(terminalDisposeCalls).toBe(0);
  });

  it("disposes a stopped terminal when a pending resume fails after close", async () => {
    const resume = deferred<Session>();
    resumeSessionMock.mockReturnValue(resume.promise);
    await renderStoppedAiSession("synthetic-session-id", false);

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    resume.reject("SESSION_RESUME_FAILED: synthetic failure");

    await waitFor(() => expect(setTabOpenMock).toHaveBeenCalledWith("codex-session", false));
    expect(terminalDisposeCalls).toBe(1);
  });

  it("does not send a stale close after a tab is reopened during resume", async () => {
    const resume = deferred<Session>();
    resumeSessionMock.mockReturnValue(resume.promise);
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    setTabOpenMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    fireEvent.click(screen.getByText("codex-session", { selector: ".a-row__title" }));
    expect(setTabOpenMock).toHaveBeenCalledWith("codex-session", true);

    await act(async () => {
      resume.resolve({
        ...stoppedAiSession("codex-session", "synthetic-session-id"),
        status: "running",
      });
      await resume.promise;
      await Promise.resolve();
    });
    expect(setTabOpenMock).not.toHaveBeenCalledWith("codex-session", false);
    act(() => {
      ptyOutputHandler?.({
        sessionId: "codex-session",
        data: "output after reopen",
        sequence: 1,
        gridEpoch: 1,
        cols: 132,
        rows: 41,
      });
    });
    expect(terminalWrites).toContain("output after reopen");
  });

  it("persists a reopen after an older close write finishes", async () => {
    const closeWrite = deferred<void>();
    setTabOpenMock.mockImplementation((_id, open) => open ? Promise.resolve() : closeWrite.promise);
    await renderStoppedAiSession("synthetic-session-id");
    setTabOpenMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(setTabOpenMock).toHaveBeenCalledWith("codex-session", false));
    fireEvent.click(screen.getByText("codex-session", { selector: ".a-row__title" }));
    expect(setTabOpenMock).toHaveBeenCalledTimes(1);

    closeWrite.resolve();
    await waitFor(() => expect(setTabOpenMock).toHaveBeenLastCalledWith("codex-session", true));
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
  });

  it("does not resurrect a session deleted while resume IPC is pending", async () => {
    const resume = deferred<Session>();
    resumeSessionMock.mockReturnValue(resume.promise);
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    const row = screen.getByText("codex-session", { selector: ".a-row__title" }).closest<HTMLElement>(".a-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(within(row).getByRole("button", { name: "Close tab from sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteSessionMock).toHaveBeenCalledWith("codex-session"));

    resume.resolve({
      ...stoppedAiSession("codex-session", "synthetic-session-id"),
      status: "running",
    });
    await resume.promise;
    await Promise.resolve();
    expect(screen.queryByText("codex-session", { selector: ".a-row__title" })).toBeNull();
    await act(async () => {
      sessionUpdatedHandler?.({
        ...stoppedAiSession("codex-session", "synthetic-session-id"),
        title: "late resurrected title",
      });
    });
    expect(screen.queryByText("late resurrected title")).toBeNull();
    const terminalCount = terminalInstances.length;
    ptyOutputHandler?.({
      sessionId: "codex-session",
      data: "late removed output",
      sequence: 1,
      gridEpoch: 1,
      cols: 132,
      rows: 41,
    });
    expect(terminalInstances).toHaveLength(terminalCount);
  });

  it("cancels a stale close when permanent deletion wins during resume", async () => {
    const resume = deferred<Session>();
    resumeSessionMock.mockReturnValue(resume.promise);
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    await waitFor(() => expect(resumeSessionMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    const row = screen.getByText("codex-session", { selector: ".a-row__title" }).closest(".a-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteSessionMock).toHaveBeenCalledWith("codex-session"));

    resume.resolve({
      ...stoppedAiSession("codex-session", "synthetic-session-id"),
      status: "running",
    });
    await resume.promise;
    await Promise.resolve();

    expect(setTabOpenMock).not.toHaveBeenCalledWith("codex-session", false);
    expect(screen.queryByText("codex-session", { selector: ".a-row__title" })).toBeNull();
  });

  it("removes a closed session after one delete click while Windows cleanup is pending", async () => {
    const deletion = deferred<void>();
    deleteSessionMock.mockReturnValue(deletion.promise);
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(setTabOpenMock).toHaveBeenCalledWith("codex-session", false));
    const row = screen.getByText("codex-session", { selector: ".a-row__title" }).closest(".a-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.queryByText("codex-session", { selector: ".a-row__title" })).toBeNull();
    expect(deleteSessionMock).toHaveBeenCalledTimes(1);
    deletion.resolve();
  });

  it("keeps a session usable when permanent deletion fails", async () => {
    deleteSessionMock.mockRejectedValue("SESSION_DELETE_FAILED: synthetic failure");
    await renderStoppedAiSession("synthetic-session-id");

    const row = screen.getByText("codex-session", { selector: ".a-row__title" }).closest<HTMLElement>(".a-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(within(row).getByRole("button", { name: "Close tab from sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteSessionMock).toHaveBeenCalledWith("codex-session"));
    fireEvent.click(screen.getByText("codex-session", { selector: ".a-row__title" }));
    expect(screen.getByRole("button", { name: /resume session/i })).toBeEnabled();
  });

  it("replaces the terminal pane with a retryable launch error", async () => {
    launchSessionMock.mockRejectedValue("CLI_NOT_FOUND: Codex is not installed");
    await renderStoppedAiSession("synthetic-session-id");

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(within(document.querySelector(".a-modal")!).getByRole("button", { name: /synthetic/i }));
    fireEvent.click(screen.getByRole("button", { name: /Codex$/ }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Could not start Codex");
    expect(error).toHaveTextContent("Install Codex and ensure it is available on PATH");

    fireEvent.click(screen.getByRole("button", { name: "Retry launch" }));
    await waitFor(() => expect(launchSessionMock).toHaveBeenLastCalledWith(FOLDER.id, "codex", { cols: 132, rows: 41 }));
  });

  it("clears a launch error when the user selects another session", async () => {
    launchSessionMock.mockRejectedValue("CLI_NOT_FOUND: Codex is not installed");
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [
        stoppedAiSession("codex-session", "synthetic-session-id"),
        runningSession("other-session"),
      ],
    }));
    getSettingsMock.mockImplementation(async () => ({ ...SETTINGS, confirmClose: false }));
    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );
    await screen.findByRole("button", { name: /resume session/i });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(within(document.querySelector(".a-modal")!).getByRole("button", { name: /synthetic/i }));
    fireEvent.click(screen.getByRole("button", { name: /Codex$/ }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByText("other-session", { selector: ".a-tab__title" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Codex profiles", () => {
  const profiles = ["alpha", "beta"];

  async function renderStoppedCodexProfileSession() {
    const session = { ...stoppedAiSession("codex-session", "synthetic-session-id"), codexProfile: "alpha" };
    getCodexProfilesMock.mockResolvedValue(profiles);
    getStateMock.mockResolvedValue({ folders: [FOLDER], sessions: [session] });
    getSettingsMock.mockResolvedValue({ ...SETTINGS, confirmClose: false });
    setCodexProfileMock.mockResolvedValue({ ...session, codexProfile: "beta" });
    render(<AnchorProvider><App /></AnchorProvider>);
    await screen.findByRole("button", { name: /resume session/i });
    return session;
  }

  it("lists each named Codex profile in the new-session chooser and folder quick launch", async () => {
    const session = await renderStoppedCodexProfileSession();
    launchSessionMock.mockResolvedValue({ ...session, id: "new-codex-session", status: "running", codexProfile: "beta" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(within(document.querySelector(".a-modal")!).getByRole("button", { name: /synthetic/i }));
    expect(screen.getByRole("button", { name: /Codex · alpha/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Codex · beta/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Codex · beta/ }));
    await waitFor(() => expect(launchSessionMock).toHaveBeenLastCalledWith(
      FOLDER.id,
      "codex",
      { cols: 132, rows: 41 },
      undefined,
      undefined,
      "beta",
    ));

    const group = screen.getByText(FOLDER.name, { selector: ".folder__name" }).closest(".folder")!;
    fireEvent.mouseEnter(group);
    fireEvent.click(screen.getByRole("button", { name: "Quick launch" }));
    expect(screen.getAllByText("Codex · alpha")).toHaveLength(1);
    expect(screen.getAllByText("Codex · beta")).toHaveLength(1);

    await waitFor(() =>
      expect(document.querySelector("[data-terminal-session-id='new-codex-session']")).not.toBeNull(),
    );
    act(() => {
      sessionStatusHandler?.({ sessionId: "new-codex-session", status: "running", exitCode: null });
      sessionUpdatedHandler?.({
        ...session,
        id: "new-codex-session",
        title: "new launch identity saved",
        status: "running",
        codexProfile: "beta",
      });
      ptyOutputHandler?.({
        sessionId: "new-codex-session",
        data: "new launch output",
        sequence: 1,
        gridEpoch: 2,
        cols: 132,
        rows: 41,
      });
    });
    expect(screen.getByText("new launch identity saved", { selector: ".a-row__title" })).toBeInTheDocument();
    await waitFor(() => expect(terminalWrites).toContain("new launch output"));
  });

  it("sets the next-resume profile from a stopped Codex session menu", async () => {
    await renderStoppedCodexProfileSession();

    expect(screen.getByText("alpha", { selector: ".resume-card__grid .v" })).toBeInTheDocument();
    const row = screen.getByText("codex-session", { selector: ".a-row__title" }).closest(".a-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: /Set Codex profile/ }));

    const selector = screen.getByRole("combobox", { name: "Codex profile" });
    expect(selector).toHaveValue("alpha");
    fireEvent.change(selector, { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(setCodexProfileMock).toHaveBeenCalledWith("codex-session", "beta"));
    expect(screen.queryByText("Codex profile", { selector: ".dialog__title" })).not.toBeInTheDocument();
  });
});

describe("confirmClose", () => {
  const confirmButton = () => screen.getByRole("button", { name: "Close session" });

  async function renderInFlightAiSessionApp(settings: Partial<Settings> = {}) {
    generateSessionTitleMock.mockResolvedValue(runningAiSession("synthetic-session"));
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [runningAiSession("synthetic-session")],
    }));
    getSettingsMock.mockImplementation(async () => ({
      ...SETTINGS,
      confirmClose: true,
      ...settings,
    }));
    render(<AnchorProvider><App /></AnchorProvider>);
    await screen.findByRole("button", { name: "Close tab" });
    await waitFor(() => expect(terminalInputHandlers).toHaveLength(1));
    await act(async () => {
      terminalInputHandlers[0]("do work\r");
      await Promise.resolve();
    });
  }

  it("asks before closing an in-progress AI response and sends nothing until answered", async () => {
    await renderInFlightAiSessionApp();

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(confirmButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
    expect(setTabOpenMock).not.toHaveBeenCalled();
    expect(stopSessionMock).not.toHaveBeenCalled();
  });

  it("closes immediately once confirmed, still with one lifecycle request", async () => {
    const close = deferred<void>();
    setTabOpenMock.mockReturnValue(close.promise);
    await renderInFlightAiSessionApp();

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    fireEvent.click(confirmButton());

    // The tab goes the moment it is confirmed, not when shutdown settles.
    expect(screen.queryByRole("button", { name: "Close tab" })).not.toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledTimes(1);
    expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
    expect(stopSessionMock).not.toHaveBeenCalled();
    close.resolve();
  });

  it("keeps the tab when the confirmation is dismissed", async () => {
    await renderInFlightAiSessionApp();

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
    expect(setTabOpenMock).not.toHaveBeenCalled();
  });

  it("does not ask for a session that is not running", async () => {
    // Nothing is killed by closing a stopped session's tab, so the prompt would
    // only be in the way.
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [{ ...runningSession("synthetic-session"), status: "stopped" as const }],
    }));
    getSettingsMock.mockImplementation(async () => ({ ...SETTINGS, confirmClose: true }));
    render(
      <AnchorProvider>
        <App />
      </AnchorProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a live but idle AI session", async () => {
    getStateMock.mockImplementation(async () => ({
      folders: [FOLDER],
      sessions: [runningAiSession("synthetic-session")],
    }));
    getSettingsMock.mockImplementation(async () => ({ ...SETTINGS, confirmClose: true }));
    render(<AnchorProvider><App /></AnchorProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
  });

  it("does not ask for a live generic terminal", async () => {
    await renderRunningSessionApp(["synthetic-session"], { confirmClose: true });

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
  });

  it("does not ask after the AI response finishes", async () => {
    await renderInFlightAiSessionApp();
    act(() => sessionStatusHandler?.({
      sessionId: "synthetic-session",
      status: "waiting",
      exitCode: null,
    }));

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
  });

  it("does not ask when closing leaves the in-progress response running", async () => {
    await renderInFlightAiSessionApp({ stopOnClose: false });

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
  });

  it("also guards the ⌘W shortcut, not just the tab's close button", async () => {
    await renderInFlightAiSessionApp();

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    expect(confirmButton()).toBeInTheDocument();
    expect(setTabOpenMock).not.toHaveBeenCalled();
  });

  it("dismisses the confirmation on Escape", async () => {
    await renderInFlightAiSessionApp();

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(setTabOpenMock).not.toHaveBeenCalled();
  });
});
