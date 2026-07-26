/**
 * Imperative xterm.js manager. Owns one Terminal per ON session and keeps it
 * alive across React re-renders and tab switches (SPEC.md §8). React views
 * only attach/detach the terminal's DOM node; the buffer lives here.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { TERMINAL_THEME } from "../components/lib/tokens";

export interface TermHandle {
  term: Terminal;
  fit: FitAddon;
  /** Stable wrapper node the view moves between the pane and an offscreen park. */
  el: HTMLDivElement;
  opened: boolean;
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

    h = { term, fit, el, opened: false };
    this.handles.set(id, h);
    return h;
  }

  /**
   * Attach a session's terminal into `parent`; opens it on first attach.
   * Returns true only on the attach that first opened the terminal, so the
   * caller can prime restored scrollback exactly once.
   */
  attach(id: string, parent: HTMLElement): boolean {
    const h = this.ensure(id);
    if (h.el.parentElement !== parent) parent.appendChild(h.el);
    let justOpened = false;
    if (!h.opened) {
      h.term.open(h.el);
      h.opened = true;
      justOpened = true;
      // WebGL is a progressive enhancement; fall back silently to canvas/DOM.
      try {
        h.term.loadAddon(new WebglAddon());
      } catch {
        /* no webgl in this environment */
      }
    }
    this.fit(id);
    return justOpened;
  }

  write(id: string, data: string): void {
    this.handles.get(id)?.term.write(data);
  }

  /** Fit to the current container; returns the new dimensions if known. */
  fit(id: string): { cols: number; rows: number } | null {
    const h = this.handles.get(id);
    if (!h || !h.opened) return null;
    try {
      h.fit.fit();
    } catch {
      return null;
    }
    const { cols, rows } = h.term;
    return { cols, rows };
  }

  setFontSize(px: number): void {
    for (const h of this.handles.values()) {
      h.term.options.fontSize = px;
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
