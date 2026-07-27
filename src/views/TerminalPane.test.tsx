import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {},
}));

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

const resizePty = vi.fn(() => Promise.resolve());
const getScrollback = vi.fn(() => Promise.resolve(""));

vi.mock("../ipc/commands", () => ({
  ipc: {
    resizePty: (...args: unknown[]) => resizePty(...(args as [])),
    getScrollback: (...args: unknown[]) => getScrollback(...(args as [])),
  },
}));

import { TerminalManager } from "../app/terminals";
import type { Session } from "../ipc/types";
import { TerminalDeck } from "./TerminalPane";

function syntheticSession(id: string): Session {
  return {
    id,
    folderId: "folder-1",
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

/** Captures the observer callbacks so a test can fire them on demand. */
let observers: Array<() => void> = [];
/** Queued animation-frame callbacks, flushed explicitly by `flushFrame`. */
let frames: Array<() => void> = [];

function flushFrame() {
  const pending = frames;
  frames = [];
  pending.forEach((callback) => callback());
}

beforeEach(() => {
  observers = [];
  frames = [];
  resizePty.mockClear();
  getScrollback.mockClear();

  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    if (handle > 0) frames[handle - 1] = () => {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TerminalDeck", () => {
  it("shows only the selected session while preserving both mounted terminals", () => {
    const terminals = new TerminalManager(() => {});
    const sessions = [syntheticSession("session-a"), syntheticSession("session-b")];
    const { container, rerender } = render(
      <TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />,
    );

    expect(container.querySelectorAll('[data-terminal-active="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-terminal-active="true"]')).toHaveAttribute(
      "data-terminal-session-id",
      "session-a",
    );

    rerender(<TerminalDeck sessions={sessions} activeId="session-b" terminals={terminals} />);

    expect(container.querySelectorAll("[data-terminal-session-id]")).toHaveLength(2);
    expect(container.querySelectorAll('[data-terminal-active="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-terminal-active="true"]')).toHaveAttribute(
      "data-terminal-session-id",
      "session-b",
    );
  });

  it("keeps exactly one visible slot across fifty alternating selections", () => {
    const terminals = new TerminalManager(() => {});
    const sessions = [syntheticSession("session-a"), syntheticSession("session-b")];
    const { container, rerender } = render(
      <TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />,
    );

    for (let i = 0; i < 50; i += 1) {
      const expected = i % 2 === 0 ? "session-b" : "session-a";
      rerender(<TerminalDeck sessions={sessions} activeId={expected} terminals={terminals} />);
      flushFrame();

      const visible = container.querySelectorAll('[data-terminal-active="true"]');
      expect(visible).toHaveLength(1);
      expect(visible[0]).toHaveAttribute("data-terminal-session-id", expected);
      expect(container.querySelectorAll("[data-terminal-session-id]")).toHaveLength(2);
    }
  });

  it("gives each session its own terminal node so buffers cannot be shared", () => {
    const terminals = new TerminalManager(() => {});
    const sessions = [syntheticSession("session-a"), syntheticSession("session-b")];
    const { container } = render(
      <TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />,
    );

    const slots = Array.from(container.querySelectorAll("[data-terminal-session-id]"));
    expect(slots).toHaveLength(2);
    expect(slots[0].firstElementChild).not.toBeNull();
    expect(slots[0].firstElementChild).not.toBe(slots[1].firstElementChild);
  });

  it("issues one resize per activation frame and none when dimensions are unchanged", () => {
    const terminals = new TerminalManager(() => {});
    const sessions = [syntheticSession("session-a")];
    render(<TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />);

    // Several observer callbacks land inside the same frame.
    observers.forEach((notify) => notify());
    observers.forEach((notify) => notify());
    flushFrame();

    expect(resizePty).toHaveBeenCalledTimes(1);
    expect(resizePty).toHaveBeenCalledWith("session-a", 80, 24);

    // A further frame with unchanged xterm dimensions must not resize again.
    observers.forEach((notify) => notify());
    flushFrame();

    expect(resizePty).toHaveBeenCalledTimes(1);
  });
});
