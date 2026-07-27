import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

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

vi.mock("../ipc/commands", () => ({
  ipc: {
    getState: (...a: unknown[]) => getStateMock(...a),
    getSettings: (...a: unknown[]) => getSettingsMock(...a),
    detectClis: (...a: unknown[]) => detectClisMock(...a),
    frontendReady: (...a: unknown[]) => frontendReadyMock(...a),
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

import type { Settings } from "../ipc/types";
import { AnchorProvider } from "./store";

const SETTINGS: Settings = {
  shell: "/bin/zsh",
  envVars: [],
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

describe("AnchorProvider boot order", () => {
  let order: string[];

  beforeEach(() => {
    order = [];
    vi.clearAllMocks();

    onPtyOutputMock.mockImplementation(async () => {
      order.push("listen-output");
      return () => {};
    });
    onSessionStatusMock.mockImplementation(async () => {
      order.push("listen-status");
      return () => {};
    });
    onSessionUpdatedMock.mockImplementation(async () => () => {});
    onAttentionCountMock.mockImplementation(async () => () => {});

    getStateMock.mockImplementation(async () => {
      order.push("get-state");
      return { folders: [], sessions: [] };
    });
    getSettingsMock.mockImplementation(async () => ({ ...SETTINGS }));
    detectClisMock.mockImplementation(async () => []);
    frontendReadyMock.mockImplementation(async () => {
      order.push("frontend-ready");
    });
  });

  it("subscribes to PTY events before requesting state and starting restore", async () => {
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
