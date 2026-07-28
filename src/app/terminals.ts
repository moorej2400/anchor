/**
 * Imperative xterm.js manager. Owns one Terminal per session and keeps it alive
 * across React re-renders and tab switches (SPEC.md §8). Each session's terminal
 * lives in its own stable slot for the lifetime of its tab; selection only
 * changes which slot is visible, so terminals are never reparented into a shared
 * host. Output is buffered from the first byte, even before the session has ever
 * been displayed.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { TERMINAL_THEME } from "../components/lib/tokens";

export interface TermHandle {
  term: Terminal;
  fit: FitAddon;
  /** Stable wrapper node that lives inside this session's own slot. */
  el: HTMLDivElement;
  opened: boolean;
  /** Whether this terminal has already asked the core to replay its output. */
  replayRequested: boolean;
  /** Last dimensions reported by `fit`, so unchanged sizes skip `resize_pty`. */
  lastCols: number | null;
  lastRows: number | null;
}

function readFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--tfs");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 13;
}

export class TerminalManager {
  private handles = new Map<string, TermHandle>();

  /** Called with (sessionId, data) whenever the user types into a terminal. */
  constructor(private onInput: (sessionId: string, data: string) => void) {}

  has(id: string): boolean {
    return this.handles.has(id);
  }

  ensure(id: string): TermHandle {
    let h = this.handles.get(id);
    if (h) return h;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: readFontSize(),
      lineHeight: 1.2,
      theme: {
        background: "#00000000",
        foreground: TERMINAL_THEME.foreground,
        cursor: "#d6417a",
        selectionBackground: "rgba(214,65,122,.3)",
      },
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => this.onInput(id, data));

    const el = document.createElement("div");
    el.style.width = "100%";
    el.style.height = "100%";

    h = {
      term,
      fit,
      el,
      opened: false,
      replayRequested: false,
      lastCols: null,
      lastRows: null,
    };
    this.handles.set(id, h);
    return h;
  }

  /**
   * Mount a session's terminal into its own stable slot, opening it on first
   * mount. Returns true only on the mount that first opened the terminal, so
   * the caller can prime restored scrollback exactly once.
   *
   * `parent` belongs to this session alone; it is never shared with another
   * session, so mounting can never displace a different terminal.
   */
  mount(id: string, parent: HTMLElement): boolean {
    const handle = this.ensure(id);
    if (handle.el.parentElement !== parent) {
      parent.replaceChildren(handle.el);
    }
    if (handle.opened) return false;

    handle.term.open(handle.el);
    handle.opened = true;
    // WebGL is a progressive enhancement; fall back silently to canvas/DOM.
    try {
      handle.term.loadAddon(new WebglAddon());
    } catch {
      /* no webgl in this environment */
    }
    return true;
  }

  /** Detach a terminal when React unmounts the slot that currently holds it. */
  unmount(id: string, parent: HTMLElement): void {
    const handle = this.handles.get(id);
    if (handle?.el.parentElement === parent) handle.el.remove();
  }

  /**
   * Claim the one replay this terminal is allowed. A terminal starts empty, so
   * it needs the core to resend a live session's output exactly once; asking
   * twice — React StrictMode runs effects twice in dev — would double it.
   */
  claimReplay(id: string): boolean {
    const handle = this.ensure(id);
    if (handle.replayRequested) return false;
    handle.replayRequested = true;
    return true;
  }

  /** Buffers into the session's terminal, creating it if it has never shown. */
  write(id: string, data: string): void {
    this.ensure(id).term.write(data);
  }

  /**
   * Fit to the current container. Returns the new dimensions only when they
   * differ from the last reported ones, so a repeated activation or an
   * unchanged ResizeObserver callback issues no `resize_pty`.
   */
  fit(id: string): { cols: number; rows: number } | null {
    const handle = this.handles.get(id);
    if (!handle?.opened) return null;
    try {
      handle.fit.fit();
    } catch {
      return null;
    }

    const { cols, rows } = handle.term;
    if (handle.lastCols === cols && handle.lastRows === rows) return null;
    handle.lastCols = cols;
    handle.lastRows = rows;
    return { cols, rows };
  }

  setFontSize(px: number): void {
    for (const h of this.handles.values()) {
      h.term.options.fontSize = px;
      // A font change resizes the grid, so the cached dimensions no longer
      // describe the PTY and the next fit must be allowed to report.
      h.lastCols = null;
      h.lastRows = null;
      if (h.opened) {
        try {
          h.fit.fit();
        } catch {
          /* not visible */
        }
      }
    }
  }

  focus(id: string): void {
    this.handles.get(id)?.term.focus();
  }

  dispose(id: string): void {
    const h = this.handles.get(id);
    if (!h) return;
    h.el.remove();
    h.term.dispose();
    this.handles.delete(id);
  }
}
