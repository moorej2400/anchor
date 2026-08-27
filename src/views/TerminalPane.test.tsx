import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 132, rows: 41 };
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;

    loadAddon() {}
    onData() {}
    attachCustomKeyEventHandler() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
  },
}));

const resizePty = vi.fn((..._args: [string, number, number] | never[]) =>
  Promise.resolve({ throughSequence: 0, gridEpoch: 2 })
);

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
    codexProfile: null,
  };
}

function terminalManager() {
  return new TerminalManager(
    () => {},
    (id, size) => resizePty(id, size.cols, size.rows),
  );
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
  vi.useRealTimers();
  observers = [];
  frames = [];
  resizePty.mockClear();

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
    const terminals = terminalManager();
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
    const terminals = terminalManager();
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
    const terminals = terminalManager();
    const sessions = [syntheticSession("session-a"), syntheticSession("session-b")];
    const { container } = render(
      <TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />,
    );

    const slots = Array.from(container.querySelectorAll("[data-terminal-session-id]"));
    expect(slots).toHaveLength(2);
    expect(slots[0].firstElementChild).not.toBeNull();
    expect(slots[0].firstElementChild).not.toBe(slots[1].firstElementChild);
  });

  it("sizes background terminals too, so their PTY is never left at 80x24", () => {
    // A live session in an unselected tab keeps producing output. If it is
    // never fitted, its CLI wraps that output for xterm's default 80 columns
    // while the pane is far wider, and the pane only looks right once a window
    // resize reflows it.
    const terminals = terminalManager();
    const sessions = [syntheticSession("session-a"), syntheticSession("session-b")];
    render(<TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />);

    flushFrame();

    const resized = resizePty.mock.calls.map(([id]) => id).sort();
    expect(resized).toEqual(["session-a", "session-b"]);
  });

  it("keeps focus on the active session when a background slot is resized", () => {
    const terminals = terminalManager();
    const focus = vi.spyOn(terminals, "focus");
    const sessions = [syntheticSession("session-a"), syntheticSession("session-b")];
    render(<TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />);

    flushFrame();
    focus.mockClear();
    // Every slot is observed now, so a window resize notifies the hidden one
    // too; that must never steal the caret from the visible terminal.
    observers.forEach((notify) => notify());
    flushFrame();

    expect(focus.mock.calls.every(([id]) => id === "session-a")).toBe(true);
  });

  it("issues one resize per activation frame and none when dimensions are unchanged", () => {
    const terminals = terminalManager();
    const sessions = [syntheticSession("session-a")];
    render(<TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />);

    // Several observer callbacks land inside the same frame.
    observers.forEach((notify) => notify());
    observers.forEach((notify) => notify());
    flushFrame();

    expect(resizePty).toHaveBeenCalledTimes(1);
    expect(resizePty).toHaveBeenCalledWith("session-a", 132, 41);

    // A further frame with unchanged xterm dimensions must not resize again.
    observers.forEach((notify) => notify());
    flushFrame();

    expect(resizePty).toHaveBeenCalledTimes(1);
  });

  it("retries rejected dimensions without another observer notification", async () => {
    vi.useFakeTimers();
    resizePty.mockRejectedValueOnce("PTY_NOT_FOUND: no live PTY for session");
    const terminals = terminalManager();
    const sessions = [syntheticSession("session-a")];
    render(<TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />);

    flushFrame();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(resizePty).toHaveBeenCalledTimes(2);
    expect(resizePty.mock.calls[1]).toEqual(["session-a", 132, 41]);
  });
});
