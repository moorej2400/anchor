import { beforeEach, describe, expect, it, vi } from "vitest";

let sessionProposedSize: { cols: number; rows: number } | null = null;

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    terminal: {
      options: { fontSize?: number; disableStdin?: boolean };
      cols: number;
      rows: number;
    } | null = null;
    activate(terminal: {
      options: { fontSize?: number; disableStdin?: boolean };
      cols: number;
      rows: number;
    }) {
      this.terminal = terminal;
    }
    fit() {
      if (this.terminal?.options.fontSize === 16) {
        this.terminal.cols = 64;
        this.terminal.rows = 20;
      }
    }
    proposeDimensions() {
      if (this.terminal?.options.fontSize === 16) return { cols: 64, rows: 20 };
      if (this.terminal?.options.disableStdin) return { cols: 132, rows: 41 };
      if (sessionProposedSize) return sessionProposedSize;
      return {
        cols: this.terminal?.cols ?? 80,
        rows: this.terminal?.rows ?? 24,
      };
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

interface FakeTerminalInstance {
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  writes: string[];
  sizesAtWrite: Array<{ cols: number; rows: number }>;
  selectedText: string;
  keyHandler: ((event: KeyboardEvent) => boolean) | null;
  resetCalls: number;
}

const terminalInstances: FakeTerminalInstance[] = [];
const terminalWriteCallbacks: Array<() => void> = [];
let deferTerminalWrites = false;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    writes: string[] = [];
    sizesAtWrite: Array<{ cols: number; rows: number }> = [];
    selectedText = "";
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    resetCalls = 0;

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      this.cols = typeof options.cols === "number" ? options.cols : 80;
      this.rows = typeof options.rows === "number" ? options.rows : 24;
      terminalInstances.push(this);
    }

    loadAddon(addon: { activate?: (terminal: unknown) => void }) {
      addon.activate?.(this);
    }
    onData() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    hasSelection() {
      return this.selectedText.length > 0;
    }
    getSelection() {
      return this.selectedText;
    }
    open() {}
    paste() {}
    write(data: string, callback?: () => void) {
      if (data) {
        this.writes.push(data);
        this.sizesAtWrite.push({ cols: this.cols, rows: this.rows });
      }
      if (!callback) return;
      if (deferTerminalWrites) terminalWriteCallbacks.push(callback);
      else callback();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    reset() {
      this.resetCalls += 1;
      this.writes = [];
      this.sizesAtWrite = [];
    }
    focus() {}
    dispose() {}
  },
}));

import { TerminalManager } from "./terminals";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeElement {
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  dispatch(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  appendChild(child: FakeElement) {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  replaceChildren(...next: FakeElement[]) {
    for (const child of [...this.children]) child.remove();
    for (const child of next) this.appendChild(child);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }
}

describe("TerminalManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
    terminalInstances.length = 0;
    terminalWriteCallbacks.length = 0;
    deferTerminalWrites = false;
    sessionProposedSize = null;
    vi.stubGlobal("document", {
      createElement: () => new FakeElement(),
    });
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: () => "",
    }));
  });

  it("buffers output until it can parse at the measured viewport size", async () => {
    const manager = new TerminalManager(() => {});

    manager.write("background-session", "output before first view");

    expect(manager.has("background-session")).toBe(true);
    expect(terminalInstances).toHaveLength(0);

    const viewportSlot = new FakeElement();
    manager.mountViewport(viewportSlot as unknown as HTMLElement);
    await manager.waitForViewport();

    expect(terminalInstances[1]?.writes).toEqual(["output before first view"]);
    expect(terminalInstances[1]?.sizesAtWrite).toEqual([{ cols: 132, rows: 41 }]);
  });

  it("mounts exactly one terminal wrapper into each stable slot", () => {
    const manager = new TerminalManager(() => {});
    const firstSlot = new FakeElement();
    const secondSlot = new FakeElement();

    manager.mount("first-session", firstSlot as unknown as HTMLElement);
    manager.mount("second-session", secondSlot as unknown as HTMLElement);

    expect(firstSlot.children).toHaveLength(1);
    expect(secondSlot.children).toHaveLength(1);
    expect(firstSlot.firstElementChild).not.toBe(secondSlot.firstElementChild);
  });

  it("keeps each session's terminal in its own slot across repeated remounts", () => {
    const manager = new TerminalManager(() => {});
    const firstSlot = new FakeElement();
    const secondSlot = new FakeElement();

    manager.mount("first-session", firstSlot as unknown as HTMLElement);
    const firstTerminal = firstSlot.firstElementChild;
    manager.mount("second-session", secondSlot as unknown as HTMLElement);
    const secondTerminal = secondSlot.firstElementChild;

    for (let i = 0; i < 50; i += 1) {
      manager.mount("first-session", firstSlot as unknown as HTMLElement);
      manager.mount("second-session", secondSlot as unknown as HTMLElement);
    }

    expect(firstSlot.children).toHaveLength(1);
    expect(secondSlot.children).toHaveLength(1);
    expect(firstSlot.firstElementChild).toBe(firstTerminal);
    expect(secondSlot.firstElementChild).toBe(secondTerminal);
  });

  it("reports the first mount only once so restored scrollback primes once", () => {
    const manager = new TerminalManager(() => {});
    const slot = new FakeElement();

    expect(manager.mount("session", slot as unknown as HTMLElement)).toBe(true);
    expect(manager.mount("session", slot as unknown as HTMLElement)).toBe(false);
  });

  it("unmounts a terminal only from the slot that currently holds it", () => {
    const manager = new TerminalManager(() => {});
    const slot = new FakeElement();
    const other = new FakeElement();

    manager.mount("session", slot as unknown as HTMLElement);
    manager.unmount("session", other as unknown as HTMLElement);
    expect(slot.children).toHaveLength(1);

    manager.unmount("session", slot as unknown as HTMLElement);
    expect(slot.children).toHaveLength(0);
  });

  it("serializes resize requests and sends the newest size after the active call", async () => {
    const first = deferred<{ throughSequence: number; gridEpoch: number }>();
    const second = deferred<{ throughSequence: number; gridEpoch: number }>();
    const resize = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const manager = new TerminalManager(() => {}, resize);
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);

    expect(manager.fit("session")).toEqual({ cols: 80, rows: 24 });
    expect(manager.fit("session")).toBeNull();
    terminalInstances[0].cols = 120;
    terminalInstances[0].rows = 36;
    expect(manager.fit("session")).toEqual({ cols: 120, rows: 36 });
    expect(resize).toHaveBeenCalledTimes(1);

    first.resolve({ throughSequence: 0, gridEpoch: 2 });
    await first.promise;
    await Promise.resolve();
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize.mock.calls[1]).toEqual(["session", { cols: 120, rows: 36 }]);

    second.resolve({ throughSequence: 0, gridEpoch: 3 });
    await second.promise;
    await Promise.resolve();
    expect(manager.fit("session")).toBeNull();
  });

  it("retries a rejected resize without another layout notification", async () => {
    vi.useFakeTimers();
    const resize = vi.fn()
      .mockRejectedValueOnce(new Error("PTY_NOT_FOUND"))
      .mockResolvedValue({ throughSequence: 0, gridEpoch: 2 });
    const manager = new TerminalManager(() => {}, resize);
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);

    manager.fit("session");
    await Promise.resolve();
    expect(resize).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("parses old output before xterm adopts the acknowledged PTY grid", async () => {
    const resizeAck = deferred<{ throughSequence: number; gridEpoch: number }>();
    const resize = vi.fn().mockReturnValue(resizeAck.promise);
    const manager = new TerminalManager(() => {}, resize);
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    await manager.prepareSession("session", { cols: 80, rows: 24 });
    manager.commitSessionPreparation("session");
    manager.mount("session", new FakeElement() as unknown as HTMLElement);
    sessionProposedSize = { cols: 120, rows: 36 };

    expect(manager.fit("session")).toEqual({ cols: 120, rows: 36 });
    manager.write("session", "old-grid output", 1, 1, 80, 24);
    expect(terminalInstances[1].cols).toBe(80);
    expect(terminalInstances[1].writes).toEqual([]);

    resizeAck.resolve({ throughSequence: 1, gridEpoch: 2 });
    await resizeAck.promise;
    await Promise.resolve();
    await Promise.resolve();
    manager.write("session", "new-grid output", 2, 2, 120, 36);

    expect(terminalInstances[1].writes).toEqual(["old-grid output", "new-grid output"]);
    expect(terminalInstances[1].sizesAtWrite).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 36 },
    ]);
  });

  it("retains a sequence observed before the terminal handle is created", async () => {
    const resize = vi.fn().mockResolvedValue({ throughSequence: 1, gridEpoch: 2 });
    const manager = new TerminalManager(() => {}, resize);
    manager.write("session", "first output", 1, 1, 80, 24);
    manager.mount("session", new FakeElement() as unknown as HTMLElement);
    sessionProposedSize = { cols: 100, rows: 30 };

    manager.fit("session");
    await Promise.resolve();
    await Promise.resolve();
    sessionProposedSize = { cols: 110, rows: 32 };
    manager.fit("session");

    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("settles old-generation resize output before failed resume preparation", async () => {
    const oldAck = deferred<{ throughSequence: number; gridEpoch: number }>();
    const resize = vi.fn()
      .mockReturnValueOnce(oldAck.promise)
      .mockResolvedValue({ throughSequence: 1, gridEpoch: 3 });
    const manager = new TerminalManager(() => {}, resize);
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    manager.mount("session", new FakeElement() as unknown as HTMLElement);
    await manager.prepareSession("session", { cols: 80, rows: 24 });
    manager.commitSessionPreparation("session");
    deferTerminalWrites = true;
    sessionProposedSize = { cols: 100, rows: 30 };
    manager.fit("session");
    manager.write("session", "final old output", 1, 1, 80, 24);
    manager.write("session", "final new-grid output", 2, 2, 100, 30);

    const preparing = manager.prepareSession("session", { cols: 120, rows: 36 });
    oldAck.resolve({ throughSequence: 1, gridEpoch: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);
    terminalWriteCallbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);
    terminalWriteCallbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);

    let prepared = false;
    void preparing.then(() => {
      prepared = true;
    });
    expect(prepared).toBe(false);
    terminalWriteCallbacks.shift()?.();
    await preparing;
    expect(prepared).toBe(true);
    manager.cancelSessionPreparation("session");
    sessionProposedSize = { cols: 140, rows: 40 };
    manager.fit("session");

    expect(terminalInstances[1].writes).toContain("final old output");
    expect(terminalInstances[1].writes).toContain("final new-grid output");
    expect(terminalInstances[1].sizesAtWrite[0]).toEqual({ cols: 80, rows: 24 });
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize.mock.calls[1]).toEqual(["session", { cols: 140, rows: 40 }]);
  });

  it("cancels parser settlement when the session is disposed", async () => {
    const resize = vi.fn().mockResolvedValue({ throughSequence: 0, gridEpoch: 2 });
    const manager = new TerminalManager(() => {}, resize);
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    const size = await manager.waitForViewport();
    manager.mount("session", new FakeElement() as unknown as HTMLElement);
    await manager.prepareSession("session", size);
    manager.commitSessionPreparation("session");
    sessionProposedSize = { cols: 100, rows: 30 };
    deferTerminalWrites = true;

    manager.fit("session");
    manager.write("session", "new-grid tail", 1, 2, 100, 30);
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);
    terminalWriteCallbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);

    const terminalCount = terminalInstances.length;
    const preparing = manager.prepareSession("session", { cols: 120, rows: 36 });
    manager.dispose("session");

    await expect(preparing).resolves.toBeUndefined();
    expect(manager.has("session")).toBe(false);
    expect(terminalInstances).toHaveLength(terminalCount);
  });

  it("measures the shared terminal viewport before any session exists", async () => {
    const manager = new TerminalManager(() => {});
    const slot = new FakeElement();

    manager.mountViewport(slot as unknown as HTMLElement);

    await expect(manager.waitForViewport()).resolves.toEqual({ cols: 132, rows: 41 });
    expect(terminalInstances[0].options.scrollback).toBe(10000);
  });

  it("waits for a fresh measurement after the viewport is detached", async () => {
    const manager = new TerminalManager(() => {});
    const firstSlot = new FakeElement();
    manager.mountViewport(firstSlot as unknown as HTMLElement);
    await manager.waitForViewport();
    manager.unmountViewport(firstSlot as unknown as HTMLElement);

    let resolved = false;
    const waiting = manager.waitForViewport().then((size) => {
      resolved = true;
      return size;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await expect(waiting).resolves.toEqual({ cols: 132, rows: 41 });
  });

  it("applies a replay snapshot once and keeps only later live sequences", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    manager.write("session", "A", 1);
    manager.write("session", "B", 2);

    await manager.applyReplay("session", {
      data: "history-A",
      throughSequence: 1,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    });
    manager.write("session", "late-A", 1);
    manager.write("session", "C", 3);

    expect(terminalInstances[1].writes).toEqual(["history-A", "B", "C"]);
  });

  it("waits for replay and queued live output to finish parsing", async () => {
    deferTerminalWrites = true;
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();

    const applying = manager.applyReplay("session", {
      data: "snapshot",
      throughSequence: 1,
      cols: 100,
      rows: 30,
      coversUnsequenced: false,
      gridEpoch: 1,
    });
    expect(terminalWriteCallbacks).toHaveLength(1);
    manager.write("session", "live while parsing", 2);

    terminalWriteCallbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);
    manager.write("session", "continuous output", 3, 1);

    terminalWriteCallbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);
    terminalWriteCallbacks.shift()?.();
    await expect(applying).resolves.toBe(true);
    expect(terminalInstances[1].writes).toEqual([
      "snapshot",
      "live while parsing",
      "continuous output",
    ]);
  });

  it("refreshes when new-grid output arrives while an old-grid replay parses", async () => {
    deferTerminalWrites = true;
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();

    const applying = manager.applyReplay("session", {
      data: "old-grid snapshot",
      throughSequence: 1,
      cols: 80,
      rows: 24,
      coversUnsequenced: false,
      gridEpoch: 1,
    });
    manager.write("session", "new-grid frame", 2, 2);
    terminalWriteCallbacks.shift()?.();

    await expect(applying).resolves.toBe(false);
    expect(terminalInstances[1].resetCalls).toBe(1);

    deferTerminalWrites = false;
    await expect(manager.applyReplay("session", {
      data: "new-grid snapshot",
      throughSequence: 2,
      cols: 120,
      rows: 40,
      coversUnsequenced: false,
      gridEpoch: 2,
    })).resolves.toBe(true);
    expect(terminalInstances[1].writes).toEqual(["new-grid snapshot"]);
  });

  it("keeps the grid-epoch watch active through the final parser barrier", async () => {
    deferTerminalWrites = true;
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();

    const applying = manager.applyReplay("session", {
      data: "old-grid snapshot",
      throughSequence: 1,
      cols: 80,
      rows: 24,
      coversUnsequenced: false,
      gridEpoch: 1,
    });
    terminalWriteCallbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWriteCallbacks).toHaveLength(1);

    manager.write("session", "late new-grid frame", 2, 2);
    terminalWriteCallbacks.shift()?.();

    await expect(applying).resolves.toBe(false);
    expect(terminalInstances[1].resetCalls).toBe(1);
  });

  it("does not duplicate restored sequence-zero output covered by the snapshot", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    manager.write("session", "saved scrollback", 0);

    await manager.applyReplay("session", {
      data: "authoritative snapshot",
      throughSequence: 2,
      cols: 132,
      rows: 41,
      coversUnsequenced: true,
      gridEpoch: 1,
    });
    manager.write("session", "late saved scrollback", 0);
    manager.write("session", "new output", 3);

    expect(terminalInstances[1].writes).toEqual(["authoritative snapshot", "new output"]);
  });

  it("uses the backend-owned fallback before live output and drops a delayed duplicate", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    manager.write("session", "saved scrollback", 0);
    manager.write("session", "live output", 1);

    await manager.applyReplay("session", {
      data: "saved scrollbackruntime snapshot",
      throughSequence: 1,
      cols: 132,
      rows: 41,
      coversUnsequenced: true,
      gridEpoch: 1,
    });
    manager.write("session", "delayed saved scrollback", 0);

    expect(terminalInstances[1].writes).toEqual(["saved scrollbackruntime snapshot"]);
  });

  it("accepts a full saved snapshot after oversized sequence-zero capture", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    manager.write("session", "old saved output".repeat(30_000), 0);

    expect(await manager.applyReplay("session", {
      data: "complete saved snapshot",
      throughSequence: 0,
      cols: 132,
      rows: 41,
      coversUnsequenced: true,
      gridEpoch: 1,
    })).toBe(true);
    expect(terminalInstances[1].writes).toEqual(["complete saved snapshot"]);
  });

  it("parses a replay at the backend PTY grid before the current webview grid", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();

    await manager.applyReplay("session", {
      data: "snapshot",
      throughSequence: 1,
      cols: 90,
      rows: 30,
      coversUnsequenced: false,
      gridEpoch: 1,
    });

    expect(terminalInstances[1]).toMatchObject({ cols: 90, rows: 30 });
    expect(terminalInstances[1].writes).toEqual(["snapshot"]);
  });

  it("clears the replay boundary before a resumed PTY restarts its sequence", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    const size = await manager.waitForViewport();
    await manager.applyReplay("session", {
      data: "old",
      throughSequence: 8,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    });
    manager.finishReplayCapture();

    await manager.prepareSession("session", size);
    manager.write("session", "new", 1);
    manager.commitSessionPreparation("session");

    expect(terminalInstances[1].writes).toEqual(["new"]);
  });

  it("keeps replay sequence boundaries when the boot buffer is capped", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    const oldChunk = "a".repeat(150_000);
    const newChunk = "b".repeat(150_000);
    manager.write("session", oldChunk, 1);
    manager.write("session", newChunk, 2);

    await manager.applyReplay("session", {
      data: "snapshot",
      throughSequence: 1,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    });

    expect(terminalInstances[1].writes).toEqual(["snapshot", newChunk]);
  });

  it("refreshes a snapshot that predates output discarded by the boot cap", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    manager.write("session", "a".repeat(150_000), 1);
    manager.write("session", "b".repeat(150_000), 2);

    expect(await manager.applyReplay("session", {
      data: "stale",
      throughSequence: 0,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    })).toBe(false);
    expect(terminalInstances).toHaveLength(1);
    expect(await manager.applyReplay("session", {
      data: "fresh",
      throughSequence: 2,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    })).toBe(true);
    expect(terminalInstances[1].writes).toEqual(["fresh"]);
  });

  it("releases a replay claim and live output when the snapshot fails", async () => {
    const manager = new TerminalManager(() => {});
    manager.beginReplayCapture();
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    await manager.waitForViewport();
    expect(manager.claimReplay("session")).toBe(true);
    manager.write("session", "live", 1);

    manager.rejectReplay("session");

    expect(manager.claimReplay("session")).toBe(true);
    expect(terminalInstances[1].writes).toEqual(["live"]);
  });

  it("resizes every open PTY when the font changes", async () => {
    const resize = vi.fn().mockResolvedValue({ throughSequence: 0, gridEpoch: 2 });
    const manager = new TerminalManager(() => {}, resize);
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);
    manager.fit("session");
    await Promise.resolve();
    await Promise.resolve();
    resize.mockClear();

    manager.setFontSize(16);

    expect(resize).toHaveBeenCalledWith("session", { cols: 64, rows: 20 });
  });

  it("does not measure a detached terminal when the font changes", async () => {
    const resize = vi.fn().mockResolvedValue({ throughSequence: 0, gridEpoch: 2 });
    const manager = new TerminalManager(() => {}, resize);
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);
    manager.fit("session");
    await Promise.resolve();
    await Promise.resolve();
    manager.unmount("session", slot as unknown as HTMLElement);
    resize.mockClear();

    manager.setFontSize(16);

    expect(resize).not.toHaveBeenCalled();
  });

  it("prepares a retained xterm at the resume grid before output can arrive", async () => {
    const manager = new TerminalManager(() => {});
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);
    manager.unmount("session", slot as unknown as HTMLElement);

    await manager.prepareSession("session", { cols: 132, rows: 41 });

    expect(terminalInstances[0].cols).toBe(132);
    expect(terminalInstances[0].rows).toBe(41);
    expect(terminalInstances[0].resetCalls).toBe(0);
  });

  it("clears the previous PTY generation before restored output arrives", async () => {
    const manager = new TerminalManager(() => {});
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    const size = await manager.waitForViewport();
    manager.mount("session", new FakeElement() as unknown as HTMLElement);
    manager.write("session", "old transcript", 1);

    await manager.prepareSession("session", size);
    manager.write("session", "restored once", 0);
    expect(terminalInstances[1].writes).toEqual(["old transcript"]);
    manager.commitSessionPreparation("session");

    expect(terminalInstances[1].writes).toEqual(["restored once"]);
  });

  it("keeps the previous screen when a prepared resume is cancelled", async () => {
    const manager = new TerminalManager(() => {});
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    const size = await manager.waitForViewport();
    manager.mount("session", new FakeElement() as unknown as HTMLElement);
    manager.write("session", "keep this transcript", 1);

    manager.beginReplayCapture();
    await manager.prepareSession("session", size);
    manager.write("session", "saved scrollback from failed spawn", 0);
    manager.cancelSessionPreparation("session");
    manager.finishReplayCapture();

    expect(terminalInstances[1].resetCalls).toBe(0);
    expect(terminalInstances[1].writes).toEqual(["keep this transcript"]);
  });

  it("commits a prepared reset when replay is the first new output", async () => {
    const manager = new TerminalManager(() => {});
    manager.mountViewport(new FakeElement() as unknown as HTMLElement);
    const size = await manager.waitForViewport();
    manager.mount("session", new FakeElement() as unknown as HTMLElement);
    manager.write("session", "old transcript", 1);
    await manager.prepareSession("session", size);

    expect(await manager.applyReplay("session", {
      data: "new snapshot",
      throughSequence: 1,
      cols: 132,
      rows: 41,
      coversUnsequenced: false,
      gridEpoch: 1,
    })).toBe(true);
    expect(terminalInstances[1].writes).toEqual(["old transcript"]);
    manager.commitSessionPreparation("session");

    expect(terminalInstances[1].writes).toEqual(["new snapshot"]);
    expect(terminalInstances[1].resetCalls).toBe(1);
  });

  it("grants each terminal exactly one replay, and a fresh one after disposal", () => {
    const manager = new TerminalManager(() => {});

    expect(manager.claimReplay("session")).toBe(true);
    expect(manager.claimReplay("session")).toBe(false);
    expect(manager.claimReplay("other")).toBe(true);

    // A disposed session's next terminal starts empty and needs its own replay.
    manager.dispose("session");
    expect(manager.claimReplay("session")).toBe(true);
  });

  it("does not fit a terminal that has never been mounted", () => {
    const manager = new TerminalManager(() => {});

    manager.write("session", "buffered");

    expect(manager.fit("session")).toBeNull();
  });

  it("keeps Ctrl+C inside xterm when nothing is selected", () => {
    const input = vi.fn();
    const manager = new TerminalManager(input);
    manager.ensure("session");

    const handled = terminalInstances[0].keyHandler?.({
      type: "keydown",
      key: "c",
      ctrlKey: true,
      metaKey: false,
    } as KeyboardEvent);

    expect(handled).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("lets the browser copy selected terminal text instead of sending Ctrl+C", () => {
    const input = vi.fn();
    const manager = new TerminalManager(input);
    manager.ensure("session");
    terminalInstances[0].selectedText = "selected terminal output";

    const handled = terminalInstances[0].keyHandler?.({
      type: "keydown",
      key: "c",
      ctrlKey: true,
      metaKey: false,
    } as KeyboardEvent);

    expect(handled).toBe(false);
    expect(input).not.toHaveBeenCalled();
  });

  it("lets the browser turn Ctrl+V into a text paste event", () => {
    const manager = new TerminalManager(() => {});
    manager.ensure("session");

    const handled = terminalInstances[0].keyHandler?.({
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
    } as KeyboardEvent);

    expect(handled).toBe(false);
  });

  it("forwards Ctrl+V to the CLI only when the paste contains an image", () => {
    const input = vi.fn();
    const manager = new TerminalManager(input);
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);
    const wrapper = slot.firstElementChild!;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    wrapper.dispatch("paste", {
      clipboardData: { items: [{ type: "image/png" }], files: [] },
      preventDefault,
      stopPropagation,
    } as unknown as ClipboardEvent);

    expect(input).toHaveBeenCalledWith("session", "\x16");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("does not turn a plain-text path paste into an image shortcut", () => {
    const input = vi.fn();
    const manager = new TerminalManager(input);
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);
    const wrapper = slot.firstElementChild!;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    wrapper.dispatch("paste", {
      clipboardData: {
        items: [{ type: "text/plain" }],
        files: [],
        getData: () => "D:\\work\\sample-repo",
      },
      preventDefault,
      stopPropagation,
    } as unknown as ClipboardEvent);

    expect(input).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});
