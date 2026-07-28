import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

const terminalInstances: Array<{ writes: string[] }> = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    writes: string[] = [];

    constructor() {
      terminalInstances.push(this);
    }

    loadAddon() {}
    onData() {}
    open() {}
    write(data: string) {
      this.writes.push(data);
    }
    focus() {}
    dispose() {}
  },
}));

import { TerminalManager } from "./terminals";

class FakeElement {
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;

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
    terminalInstances.length = 0;
    vi.stubGlobal("document", {
      createElement: () => new FakeElement(),
    });
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: () => "",
    }));
  });

  it("buffers output before a terminal is mounted", () => {
    const manager = new TerminalManager(() => {});

    manager.write("background-session", "output before first view");

    expect(manager.has("background-session")).toBe(true);
    expect(terminalInstances[0]?.writes).toEqual(["output before first view"]);
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

  it("reports dimensions only when they change", () => {
    const manager = new TerminalManager(() => {});
    const slot = new FakeElement();
    manager.mount("session", slot as unknown as HTMLElement);

    expect(manager.fit("session")).toEqual({ cols: 80, rows: 24 });
    expect(manager.fit("session")).toBeNull();
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
});
