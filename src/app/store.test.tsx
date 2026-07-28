import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    onData() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
  },
}));

const getStateMock = vi.fn();
const getSettingsMock = vi.fn();
const detectClisMock = vi.fn();
const frontendReadyMock = vi.fn();
const setTabOpenMock = vi.fn();
const stopSessionMock = vi.fn();
const resizePtyMock = vi.fn();
const replayOutputMock = vi.fn();
const getScrollbackMock = vi.fn();
const setSettingsMock = vi.fn();

vi.mock("../ipc/commands", () => ({
  ipc: {
    getState: (...a: unknown[]) => getStateMock(...a),
    getSettings: (...a: unknown[]) => getSettingsMock(...a),
    detectClis: (...a: unknown[]) => detectClisMock(...a),
    frontendReady: (...a: unknown[]) => frontendReadyMock(...a),
    setTabOpen: (...a: unknown[]) => setTabOpenMock(...a),
    stopSession: (...a: unknown[]) => stopSessionMock(...a),
    resizePty: (...a: unknown[]) => resizePtyMock(...a),
    replayOutput: (...a: unknown[]) => replayOutputMock(...a),
    getScrollback: (...a: unknown[]) => getScrollbackMock(...a),
    setSettings: (...a: unknown[]) => setSettingsMock(...a),
  },
}));

const onPtyOutputMock = vi.fn();
const onSessionStatusMock = vi.fn();
const onSessionUpdatedMock = vi.fn();
const onAttentionCountMock = vi.fn();

vi.mock("../ipc/events", () => ({
  onPtyOutput: (...a: unknown[]) => onPtyOutputMock(...a),
  onSessionStatus: (...a: unknown[]) => onSessionStatusMock(...a),
  onSessionUpdated: (...a: unknown[]) => onSessionUpdatedMock(...a),
  onAttentionCount: (...a: unknown[]) => onAttentionCountMock(...a),
}));

import type { Folder, Session, Settings } from "../ipc/types";
import App from "../App";
import { AnchorProvider } from "./store";

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
  accent: "#d6417a",
  notifyOnWaiting: false,
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

  onPtyOutputMock.mockImplementation(async () => () => {});
  onSessionStatusMock.mockImplementation(async () => () => {});
  onSessionUpdatedMock.mockImplementation(async () => () => {});
  onAttentionCountMock.mockImplementation(async () => () => {});

  getStateMock.mockImplementation(async () => ({ folders: [], sessions: [] }));
  getSettingsMock.mockImplementation(async () => ({ ...SETTINGS }));
  detectClisMock.mockImplementation(async () => []);
  frontendReadyMock.mockImplementation(async () => {});
  setTabOpenMock.mockResolvedValue(undefined);
  stopSessionMock.mockResolvedValue(undefined);
  resizePtyMock.mockResolvedValue(undefined);
  replayOutputMock.mockResolvedValue(undefined);
  getScrollbackMock.mockResolvedValue("");
  setSettingsMock.mockImplementation(async (settings: Settings) => settings);

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
    frontendReadyMock.mockImplementation(async () => {
      order.push("frontend-ready");
    });

    render(
      <AnchorProvider>
        <div>ready</div>
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
        <div>ready</div>
      </AnchorProvider>,
    );
    await waitFor(() => expect(frontendReadyMock).toHaveBeenCalledTimes(1));
  });
});

describe("recovering terminals after a page reload", () => {
  function bootWith(sessions: Session[], strict = false) {
    getStateMock.mockImplementation(async () => ({ folders: [FOLDER], sessions }));
    const tree = (
      <AnchorProvider>
        <div>ready</div>
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
    // A stopped session shows the Resume card and owns no terminal.
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

describe("confirmClose", () => {
  const confirmButton = () => screen.getByRole("button", { name: "Close session" });

  it("asks before closing a running session and sends nothing until answered", async () => {
    await renderRunningSessionApp(["synthetic-session"], { confirmClose: true });

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

    expect(confirmButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
    expect(setTabOpenMock).not.toHaveBeenCalled();
    expect(stopSessionMock).not.toHaveBeenCalled();
  });

  it("closes immediately once confirmed, still with one lifecycle request", async () => {
    const close = deferred<void>();
    setTabOpenMock.mockReturnValue(close.promise);
    await renderRunningSessionApp(["synthetic-session"], { confirmClose: true });

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
    await renderRunningSessionApp(["synthetic-session"], { confirmClose: true });

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

  it("also guards the ⌘W shortcut, not just the tab's close button", async () => {
    await renderRunningSessionApp(["synthetic-session"], { confirmClose: true });

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    expect(confirmButton()).toBeInTheDocument();
    expect(setTabOpenMock).not.toHaveBeenCalled();
  });

  it("dismisses the confirmation on Escape", async () => {
    await renderRunningSessionApp(["synthetic-session"], { confirmClose: true });

    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("button", { name: "Close session" })).not.toBeInTheDocument();
    expect(setTabOpenMock).not.toHaveBeenCalled();
  });
});
