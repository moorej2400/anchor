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
import type { PtyReplay, PtyResize, TerminalSize } from "../ipc/types";

const CTRL_V = "\x16";
// Mirrors the backend's retained-output cap closely enough for UTF-8 text while
// preventing a stalled webview boot from becoming an unbounded second buffer.
const MAX_PENDING_OUTPUT_CHARS = 256 * 1024;

interface PendingOutput {
  chunks: string[];
  length: number;
}

interface SequencedOutput {
  data: string;
  sequence: number;
  gridEpoch: number;
  cols: number;
  rows: number;
}

interface ReplayBuffer {
  chunks: SequencedOutput[];
  length: number;
  droppedThroughSequence: number;
  unsequencedOverflow: boolean;
}

interface ResizeTransition {
  target: TerminalSize;
  chunks: SequencedOutput[];
  ack: PtyResize | null;
  committing: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

function resizeTransition(target: TerminalSize, ack: PtyResize | null = null): ResizeTransition {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return { target, chunks: [], ack, committing: false, done, resolveDone };
}

function appendReplayOutput(replay: ReplayBuffer, chunk: SequencedOutput): void {
  replay.chunks.push(chunk);
  replay.length += chunk.data.length;
  if (replay.length <= MAX_PENDING_OUTPUT_CHARS) return;
  // Keep sequence boundaries intact while more than one event remains. This
  // lets a newer snapshot cover every dropped event without partial replay.
  while (replay.length > MAX_PENDING_OUTPUT_CHARS && replay.chunks.length > 1) {
    const removed = replay.chunks.shift();
    replay.length -= removed?.data.length ?? 0;
    if (removed?.sequence) {
      replay.droppedThroughSequence = Math.max(replay.droppedThroughSequence, removed.sequence);
    } else {
      replay.unsequencedOverflow = true;
    }
  }
  if (replay.length > MAX_PENDING_OUTPUT_CHARS && replay.chunks.length === 1) {
    const only = replay.chunks[0];
    if (only.sequence) {
      replay.droppedThroughSequence = Math.max(replay.droppedThroughSequence, only.sequence);
    } else {
      replay.unsequencedOverflow = true;
    }
    only.data = retainedTail(only.data);
    replay.length = only.data.length;
  }
}

export interface TermHandle {
  term: Terminal;
  fit: FitAddon;
  /** Stable wrapper node that lives inside this session's own slot. */
  el: HTMLDivElement;
  opened: boolean;
  attached: boolean;
  /** Size the backend confirmed, not merely the last attempted resize. */
  appliedSize: TerminalSize | null;
  /** Newest measured size; one serialized worker sends it to the backend. */
  desiredSize: TerminalSize | null;
  resizeInFlight: boolean;
  resizeFailures: number;
  retryTimer: number | undefined;
  /** Highest live sequence observed or covered by an authoritative replay. */
  observedSequence: number;
  /** PTY grid epoch currently used by xterm. Zero means not established yet. */
  gridEpoch: number;
  /** Holds output between the PTY and xterm sides of one grid transition. */
  resizeTransition: ResizeTransition | null;
  /** Full parser settlement remains visible after the finite buffer is cut. */
  resizeSettling: ResizeTransition | null;
  preparing: boolean;
  resetPending: boolean;
  preparedOutput: PendingOutput;
}

interface ViewportHandle {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
}

function readFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--tfs");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 13;
}

function clipboardContainsImage(event: ClipboardEvent): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  return (
    Array.from(clipboard.items).some((item) => item.type.toLowerCase().startsWith("image/")) ||
    Array.from(clipboard.files).some((file) => file.type.toLowerCase().startsWith("image/"))
  );
}

function terminalOptions(disableStdin = false, size?: TerminalSize) {
  return {
    allowProposedApi: true,
    cursorBlink: !disableStdin,
    disableStdin,
    fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: readFontSize(),
    lineHeight: 1.2,
    theme: {
      background: "#00000000",
      foreground: TERMINAL_THEME.foreground,
      cursor: "#d6417a",
      selectionBackground: "rgba(214,65,122,.3)",
    },
    // FitAddon accounts for scrollbar width from this option. The viewport
    // probe must match session terminals even though it never receives output.
    scrollback: 10000,
    ...(size ?? {}),
  };
}

function sameSize(left: TerminalSize | null, right: TerminalSize): boolean {
  return left?.cols === right.cols && left.rows === right.rows;
}

function retainedTail(data: string): string {
  if (data.length <= MAX_PENDING_OUTPUT_CHARS) return data;
  const overflow = data.length - MAX_PENDING_OUTPUT_CHARS;
  const newline = data.indexOf("\n", overflow);
  // Prefer a complete next line, like the backend buffer. Full-screen TUIs can
  // exceed the cap without a newline; keeping their tail is better than losing
  // every byte, even though that rare fallback can start inside an ANSI run.
  return data.slice(newline >= 0 ? newline + 1 : overflow);
}

export class TerminalManager {
  private handles = new Map<string, TermHandle>();
  private pendingOutput = new Map<string, PendingOutput>();
  private replayCapture = false;
  private replayBuffers = new Map<string, ReplayBuffer>();
  /** Lossless live chunks held while xterm parses an accepted replay. */
  private replayParsing = new Map<string, ReplayBuffer>();
  private replayResolved = new Set<string>();
  private replayBoundaries = new Map<string, number>();
  private replayClaims = new Set<string>();
  private observedSequences = new Map<string, number>();
  private ignoredOutputIds = new Set<string>();
  private viewport: ViewportHandle | null = null;
  private viewportAttached = false;
  private viewportSize: TerminalSize | null = null;
  private viewportWaiters = new Set<(size: TerminalSize) => void>();

  /** Called with (sessionId, data) whenever the user types into a terminal. */
  constructor(
    private onInput: (sessionId: string, data: string) => void,
    private onResize?: (sessionId: string, size: TerminalSize) => Promise<PtyResize>,
    private onResizeError?: (sessionId: string, error: unknown) => void,
  ) {}

  has(id: string): boolean {
    return this.handles.has(id) || this.pendingOutput.has(id) || this.replayBuffers.has(id) ||
      this.replayParsing.has(id);
  }

  ensure(id: string): TermHandle {
    let h = this.handles.get(id);
    if (h) return h;

    // Once the viewport is known, every xterm starts at the same grid as its
    // PTY. This matters when output arrives before React mounts the session.
    const term = new Terminal(terminalOptions(false, this.viewportSize ?? undefined));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => this.onInput(id, data));
    // Returning false leaves desktop clipboard shortcuts to the browser;
    // Ctrl+C without a selection stays in xterm as the terminal interrupt.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier || event.altKey) return true;
      const key = event.key.toLowerCase();
      if (key === "v") return false;
      if (key === "c" && term.hasSelection()) return false;
      return true;
    });

    const el = document.createElement("div");
    el.style.width = "100%";
    el.style.height = "100%";
    el.addEventListener(
      "paste",
      (event) => {
        if (!clipboardContainsImage(event)) return;
        // Codex uses raw Ctrl+V for clipboard images, while text must stay a
        // browser paste event so xterm can emit bracketed text instead.
        event.preventDefault();
        event.stopPropagation();
        this.onInput(id, CTRL_V);
      },
      true,
    );

    h = {
      term,
      fit,
      el,
      opened: false,
      attached: false,
      appliedSize: null,
      desiredSize: null,
      resizeInFlight: false,
      resizeFailures: 0,
      retryTimer: undefined,
      observedSequence: this.observedSequences.get(id) ?? 0,
      gridEpoch: 0,
      resizeTransition: null,
      resizeSettling: null,
      preparing: false,
      resetPending: false,
      preparedOutput: { chunks: [], length: 0 },
    };
    this.handles.set(id, h);
    return h;
  }

  /**
   * Mount a session's terminal into its own stable slot, opening it on first
   * mount. Returns true only on the mount that first opened the terminal.
   *
   * `parent` belongs to this session alone; it is never shared with another
   * session, so mounting can never displace a different terminal.
   */
  mount(id: string, parent: HTMLElement): boolean {
    const handle = this.ensure(id);
    if (handle.el.parentElement !== parent) {
      parent.replaceChildren(handle.el);
    }
    handle.attached = true;
    if (handle.opened) return false;

    handle.term.open(handle.el);
    handle.opened = true;
    // WebGL is a progressive enhancement; fall back silently to canvas/DOM.
    try {
      const webgl = new WebglAddon();
      // Browsers cap live WebGL contexts and drop the oldest, and the GPU
      // process can restart under us. A dropped context leaves the terminal
      // frozen or blank, so hand rendering back to the DOM renderer rather
      // than keeping a dead addon attached.
      webgl.onContextLoss(() => webgl.dispose());
      handle.term.loadAddon(webgl);
    } catch {
      /* no webgl in this environment */
    }
    return true;
  }

  /** Detach a terminal when React unmounts the slot that currently holds it. */
  unmount(id: string, parent: HTMLElement): void {
    const handle = this.handles.get(id);
    if (handle?.el.parentElement === parent) {
      handle.el.remove();
      handle.attached = false;
    }
  }

  /**
   * Mount a non-interactive xterm into the real terminal box. Anchor v1 has one
   * pane size, so this gives every lifecycle path exact grid dimensions before
   * any child process can draw its first frame.
   */
  mountViewport(parent: HTMLElement): void {
    if (!this.viewport) {
      const term = new Terminal(terminalOptions(true));
      const fit = new FitAddon();
      term.loadAddon(fit);
      const el = document.createElement("div");
      el.style.width = "100%";
      el.style.height = "100%";
      this.viewport = { term, fit, el, opened: false };
    }

    const viewport = this.viewport;
    if (viewport.el.parentElement !== parent) parent.replaceChildren(viewport.el);
    this.viewportAttached = true;
    if (!viewport.opened) {
      viewport.term.open(viewport.el);
      viewport.opened = true;
    }
    this.measureViewport();
  }

  unmountViewport(parent: HTMLElement): void {
    if (this.viewport?.el.parentElement === parent) {
      this.viewport.el.remove();
      this.viewportAttached = false;
    }
  }

  /** Re-measure the pane with xterm's own cell metrics, never pixel estimates. */
  measureViewport(): TerminalSize | null {
    const viewport = this.viewport;
    if (!viewport?.opened || !this.viewportAttached) return null;
    try {
      const proposed = viewport.fit.proposeDimensions();
      if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return null;
      viewport.fit.fit();
      const size = { cols: proposed.cols, rows: proposed.rows };
      this.viewportSize = size;
      this.flushPendingOutput(size);
      for (const resolve of this.viewportWaiters) resolve(size);
      this.viewportWaiters.clear();
      return size;
    } catch {
      // xterm can be between mounts; the host observer will measure again.
      return null;
    }
  }

  /** Wait until the terminal deck can supply a real grid for a first spawn. */
  waitForViewport(): Promise<TerminalSize> {
    // A detached probe describes the previous terminal view. Wait for React to
    // mount the current pane instead of spawning against stale dimensions.
    const size = this.measureViewport();
    if (size) return Promise.resolve(size);
    return new Promise((resolve) => this.viewportWaiters.add(resolve));
  }

  /**
   * Claim the one replay this terminal is allowed. A terminal starts empty, so
   * it needs the core to resend a live session's output exactly once; asking
   * twice — React StrictMode runs effects twice in dev — would double it.
   */
  claimReplay(id: string): boolean {
    if (this.replayClaims.has(id)) return false;
    this.replayClaims.add(id);
    return true;
  }

  /** Hold subscribed live output until each boot snapshot defines its boundary. */
  beginReplayCapture(): void {
    this.replayCapture = true;
  }

  /** Buffer raw bytes until xterm can parse them at the measured PTY grid. */
  write(
    id: string,
    data: string,
    sequence = 0,
    gridEpoch = 0,
    cols = 0,
    rows = 0,
  ): void {
    if (this.ignoredOutputIds.has(id)) return;
    if (sequence > 0) {
      this.observedSequences.set(
        id,
        Math.max(this.observedSequences.get(id) ?? 0, sequence),
      );
    }
    const handle = this.handles.get(id);
    if (handle && sequence > 0) {
      handle.observedSequence = Math.max(handle.observedSequence, sequence);
    }
    const replayBoundary = this.replayBoundaries.get(id);
    if (
      replayBoundary !== undefined &&
      (sequence === 0 || (sequence > 0 && sequence <= replayBoundary))
    ) return;
    const parsing = this.replayParsing.get(id);
    if (parsing) {
      appendReplayOutput(parsing, { data, sequence, gridEpoch, cols, rows });
      return;
    }
    if (this.handles.get(id)?.resetPending) {
      // Prepared output belongs to a transactional resume, not to the global
      // boot replay. Failure must be able to discard it without touching the
      // previous screen or another session's capture.
      this.writePrepared(id, data);
      return;
    }
    if (handle?.resizeTransition) {
      handle.resizeTransition.chunks.push({ data, sequence, gridEpoch, cols, rows });
      this.tryCommitResize(id, handle);
      return;
    }
    if (this.replayCapture && !this.replayResolved.has(id)) {
      const replay = this.replayBuffers.get(id) ?? {
        chunks: [],
        length: 0,
        droppedThroughSequence: 0,
        unsequencedOverflow: false,
      };
      appendReplayOutput(replay, { data, sequence, gridEpoch, cols, rows });
      this.replayBuffers.set(id, replay);
      return;
    }
    if (
      handle && gridEpoch > 0 && cols > 0 && rows > 0 &&
      handle.gridEpoch !== gridEpoch
    ) {
      if (handle.gridEpoch > gridEpoch) return;
      this.beginEventGridTransition(
        id,
        handle,
        { data, sequence, gridEpoch, cols, rows },
      );
      return;
    }
    this.writePrepared(id, data);
  }

  /** Recover a PTY grid change observed before its command response reaches us. */
  private beginEventGridTransition(
    id: string,
    handle: TermHandle,
    first: SequencedOutput,
  ): void {
    const target = { cols: first.cols, rows: first.rows };
    const transition = resizeTransition(target, {
        throughSequence: Math.max(0, first.sequence - 1),
        gridEpoch: first.gridEpoch,
      });
    transition.chunks.push(first);
    handle.resizeTransition = transition;
    handle.resizeSettling = transition;
    handle.resizeInFlight = true;
    this.tryCommitResize(id, handle);
  }

  private writePrepared(id: string, data: string): void {
    const handle = this.handles.get(id);
    if (!handle?.resetPending) {
      this.writeMeasured(id, data);
      return;
    }
    handle.preparedOutput.chunks.push(data);
    handle.preparedOutput.length += data.length;
    // Generic-terminal preparation can contain the complete authoritative
    // saved transcript. Applying the live boot cap here would silently discard
    // history that xterm can still retain, so this short-lived transaction is
    // lossless and is cleared as soon as spawn succeeds or fails.
  }

  private writeMeasured(id: string, data: string): void {
    if (!this.viewportSize) {
      const pending = this.pendingOutput.get(id) ?? { chunks: [], length: 0 };
      pending.chunks.push(data);
      pending.length += data.length;
      if (pending.length > MAX_PENDING_OUTPUT_CHARS) {
        const retained = retainedTail(pending.chunks.join(""));
        pending.chunks = [retained];
        pending.length = retained.length;
      }
      this.pendingOutput.set(id, pending);
      return;
    }
    this.ensure(id).term.write(data);
  }

  /** Replace buffered output with one gap-free snapshot; false requests refresh. */
  async applyReplay(id: string, replay: PtyReplay): Promise<boolean> {
    const capture = this.replayBuffers.get(id);
    if (
      (capture?.unsequencedOverflow && !replay.coversUnsequenced) ||
      (capture?.droppedThroughSequence ?? 0) > replay.throughSequence ||
      capture?.chunks.some((chunk) =>
        chunk.sequence > replay.throughSequence && chunk.gridEpoch !== 0 &&
        replay.gridEpoch !== 0 && chunk.gridEpoch !== replay.gridEpoch)
    ) {
      // The backend snapshot predates output discarded by the frontend cap.
      // Keep capture active so a newer snapshot can cover the missing range.
      return false;
    }
    if (replay.cols > 0 && replay.rows > 0) {
      this.prepareReplaySession(id, { cols: replay.cols, rows: replay.rows });
    }
    const buffered = capture?.chunks ?? [];
    this.replayBuffers.delete(id);
    this.replayBoundaries.set(id, replay.throughSequence);
    const replayHandle = this.handles.get(id);
    if (replayHandle) {
      replayHandle.observedSequence = Math.max(
        replayHandle.observedSequence,
        replay.throughSequence,
      );
      replayHandle.gridEpoch = replay.gridEpoch;
    }
    this.observedSequences.set(
      id,
      Math.max(this.observedSequences.get(id) ?? 0, replay.throughSequence),
    );
    this.replayParsing.set(id, {
      chunks: [],
      length: 0,
      droppedThroughSequence: 0,
      unsequencedOverflow: false,
    });
    const output: string[] = [];
    if (!replay.coversUnsequenced) {
      // Saved scrollback is emitted before the live PTY starts. When runtime
      // replay cannot cover it, preserve those captured chunks before the
      // runtime snapshot instead of silently dropping the recovered history.
      for (const chunk of buffered) {
        if (chunk.sequence === 0) output.push(chunk.data);
      }
    }
    if (replay.data) output.push(replay.data);
    for (const chunk of buffered) {
      if (chunk.sequence > replay.throughSequence) {
        output.push(chunk.data);
      }
    }
    await this.writePreparedChunksAndWait(id, output);
    const live = this.replayParsing.get(id);
    if (
      live &&
      (live.unsequencedOverflow || live.droppedThroughSequence > replay.throughSequence ||
        live.chunks.some((chunk) =>
          chunk.gridEpoch !== 0 && replay.gridEpoch !== 0 &&
          chunk.gridEpoch !== replay.gridEpoch))
    ) {
      // The accepted snapshot was parsed only in a hidden boot xterm. Reset it
      // and refresh once output crosses a grid epoch or the finite handoff cap.
      this.replayBuffers.set(id, live);
      this.replayBoundaries.delete(id);
      this.handles.get(id)?.term.reset();
      return false;
    }
    const handoff = (live?.chunks ?? []).map((chunk) => chunk.data);
    if (live) {
      live.chunks = [];
      live.length = 0;
      live.droppedThroughSequence = 0;
      live.unsequencedOverflow = false;
    }
    if (handoff.length > 0) {
      await this.writePreparedChunksAndWait(id, handoff);
    } else {
      await this.waitForParserBarrier(id);
    }
    const afterHandoff = this.replayParsing.get(id);
    this.replayParsing.delete(id);
    if (
      afterHandoff &&
      (afterHandoff.unsequencedOverflow ||
        afterHandoff.droppedThroughSequence > replay.throughSequence ||
        afterHandoff.chunks.some((chunk) =>
          chunk.gridEpoch !== 0 && replay.gridEpoch !== 0 &&
          chunk.gridEpoch !== replay.gridEpoch))
    ) {
      // Keep watching through the final xterm callback. An event from a newer
      // PTY grid can cross the independent command/event queues after the
      // first replay write resolves but before the parser handoff completes.
      this.replayBuffers.set(id, afterHandoff);
      this.replayBoundaries.delete(id);
      this.handles.get(id)?.term.reset();
      return false;
    }
    this.replayResolved.add(id);
    const postHandoff = (afterHandoff?.chunks ?? []).map((chunk) => chunk.data);
    if (postHandoff.length > 0) {
      await this.writePreparedChunksAndWait(id, postHandoff);
    }
    return true;
  }

  private async writePreparedChunksAndWait(id: string, chunks: string[]): Promise<void> {
    for (const chunk of chunks.slice(0, -1)) this.writePrepared(id, chunk);
    const finalChunk = chunks[chunks.length - 1];
    if (finalChunk) await this.writePreparedAndWait(id, finalChunk);
  }

  /** Resolve only after xterm has parsed this final queued chunk. */
  private writePreparedAndWait(id: string, data: string): Promise<void> {
    const handle = this.handles.get(id);
    // A permanent close can dispose the handle while an earlier parser phase
    // settles. Do not recreate that deleted terminal from the stale callback.
    if (!handle) return Promise.resolve();
    if (handle.resetPending || !this.viewportSize) {
      this.writePrepared(id, data);
      return Promise.resolve();
    }
    return new Promise((resolve) => handle.term.write(data, resolve));
  }

  /** Queue a finite handoff marker before later live event tasks can write. */
  private waitForParserBarrier(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle || handle.resetPending || !this.viewportSize) return Promise.resolve();
    return new Promise((resolve) => handle.term.write("", resolve));
  }

  /** A failed snapshot must not permanently consume the replay claim or output. */
  rejectReplay(id: string): void {
    const buffered = this.replayBuffers.get(id)?.chunks ?? [];
    this.replayBuffers.delete(id);
    this.replayParsing.delete(id);
    this.replayResolved.add(id);
    this.replayClaims.delete(id);
    this.replayBoundaries.delete(id);
    for (const chunk of buffered) this.writeMeasured(id, chunk.data);
  }

  /** Release output for sessions that did not need a boot snapshot. */
  finishReplayCapture(): void {
    this.replayCapture = false;
    for (const id of [...this.replayBuffers.keys()]) this.rejectReplay(id);
    this.replayResolved.clear();
  }

  private flushPendingOutput(size: TerminalSize): void {
    for (const [id, pending] of this.pendingOutput) {
      const handle = this.ensure(id);
      // `ensure` normally receives `size` through viewportSize. Resize handles
      // created earlier by hydration before parsing their first buffered byte.
      if (handle.term.cols !== size.cols || handle.term.rows !== size.rows) {
        handle.term.resize(size.cols, size.rows);
      }
      for (const chunk of pending.chunks) handle.term.write(chunk);
    }
    this.pendingOutput.clear();
  }

  /**
   * Measure the current container and claim dimensions that still need backend
   * acknowledgement. xterm keeps the old grid until the PTY returns its exact
   * old-output boundary; changing it early would parse in-flight bytes at the
   * wrong width. An unchanged in-flight claim is not duplicated.
   */
  fit(id: string): TerminalSize | null {
    const handle = this.handles.get(id);
    if (!handle?.opened || !handle.attached || handle.resetPending || handle.preparing) return null;
    let proposed;
    try {
      proposed = handle.fit.proposeDimensions();
    } catch {
      return null;
    }
    if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return null;
    const size = { cols: proposed.cols, rows: proposed.rows };
    if (sameSize(handle.desiredSize, size)) return null;
    if (!handle.resizeInFlight && sameSize(handle.appliedSize, size)) return null;
    handle.desiredSize = size;
    handle.resizeFailures = 0;
    this.pumpResize(id);
    return size;
  }

  private pumpResize(id: string): void {
    const handle = this.handles.get(id);
    const size = handle?.desiredSize;
    if (
      !handle || !size || handle.resizeInFlight || handle.preparing ||
      handle.resetPending || !this.onResize
    ) return;
    if (sameSize(handle.appliedSize, size)) {
      handle.desiredSize = null;
      return;
    }

    handle.resizeInFlight = true;
    const transition = resizeTransition(size);
    handle.resizeTransition = transition;
    handle.resizeSettling = transition;
    void this.onResize(id, size).then(
      (ack) => {
        const current = this.handles.get(id);
        if (current !== handle) return;
        if (current.resizeTransition !== transition) return;
        transition.ack = ack;
        this.tryCommitResize(id, current);
      },
      (error) => {
        const current = this.handles.get(id);
        if (current !== handle) return;
        if (current.resizeTransition !== transition) return;
        this.failResize(id, current, size, error);
      },
    );
  }

  private tryCommitResize(id: string, handle: TermHandle): void {
    const transition = handle.resizeTransition;
    const ack = transition?.ack;
    if (!transition || !ack || transition.committing) return;
    // The command response and event queue are independent. Do not change the
    // xterm grid until every old-grid event covered by the backend boundary has
    // reached this manager.
    if (handle.observedSequence < ack.throughSequence) return;
    transition.committing = true;
    void this.commitResize(id, handle, transition, ack);
  }

  private async commitResize(
    id: string,
    handle: TermHandle,
    transition: ResizeTransition,
    ack: PtyResize,
  ): Promise<void> {
    const oldGrid = transition.chunks
      .filter((chunk) => chunk.sequence === 0 || chunk.sequence <= ack.throughSequence)
      .map((chunk) => chunk.data);
    if (oldGrid.length > 0) {
      await this.writePreparedChunksAndWait(id, oldGrid);
    } else {
      await this.waitForParserBarrier(id);
    }
    const current = this.handles.get(id);
    if (current !== handle || current.resizeTransition !== transition) return;

    // Sequence ordering guarantees that later arrivals now belong to the new
    // epoch. Resize synchronously, queue that finite backlog, then release live
    // writes; xterm preserves the queue order for all following event tasks.
    handle.term.resize(transition.target.cols, transition.target.rows);
    const newGrid = transition.chunks
      .filter((chunk) => chunk.sequence > ack.throughSequence)
      .map((chunk) => chunk.data);
    handle.resizeTransition = null;
    handle.resizeFailures = 0;
    handle.appliedSize = transition.target;
    handle.gridEpoch = ack.gridEpoch;
    if (sameSize(handle.desiredSize, transition.target)) handle.desiredSize = null;
    // Keep the transaction alive through the new-grid parser callback. Resume
    // preparation waits on `done`, so no old-generation bytes can cross its
    // later resize/reset boundary.
    if (newGrid.length > 0) {
      await this.writePreparedChunksAndWait(id, newGrid);
    }
    transition.resolveDone();
    if (handle.resizeSettling === transition) handle.resizeSettling = null;
    handle.resizeInFlight = false;
    this.pumpResize(id);
  }

  private failResize(
    id: string,
    handle: TermHandle,
    size: TerminalSize,
    error: unknown,
  ): void {
    const transition = handle.resizeTransition;
    const buffered = transition?.chunks ?? [];
    handle.resizeTransition = null;
    if (handle.resizeSettling === transition) handle.resizeSettling = null;
    handle.resizeInFlight = false;
    // A rejected backend resize leaves both sides at the old grid. Release all
    // bytes there before retrying the same measured dimensions.
    for (const chunk of buffered) this.writePrepared(id, chunk.data);
    transition?.resolveDone();
    if (!sameSize(handle.desiredSize, size)) {
      handle.resizeFailures = 0;
      this.pumpResize(id);
      return;
    }

    handle.resizeFailures += 1;
    if (handle.resizeFailures <= 2) {
      // PTY creation and first slot mount can cross by one event turn. A
      // bounded retry heals that race without waiting for another resize.
      const delay = 50 * 2 ** (handle.resizeFailures - 1);
      handle.retryTimer = window.setTimeout(() => {
        handle.retryTimer = undefined;
        this.pumpResize(id);
      }, delay);
      return;
    }
    handle.desiredSize = null;
    handle.resizeFailures = 0;
    this.onResizeError?.(id, error);
  }

  setFontSize(px: number): void {
    for (const [id, h] of this.handles) {
      h.term.options.fontSize = px;
      // A font change resizes the grid, so the cached dimensions no longer
      // describe the PTY and the next fit must be allowed to report.
      h.appliedSize = null;
      h.desiredSize = null;
      h.resizeFailures = 0;
      if (h.retryTimer !== undefined) {
        window.clearTimeout(h.retryTimer);
        h.retryTimer = undefined;
      }
      if (h.opened) {
        this.fit(id);
      }
    }
    if (this.viewport) {
      this.viewport.term.options.fontSize = px;
      this.measureViewport();
    }
  }

  /** Match a retained xterm to the grid the resumed PTY will use before spawn. */
  async prepareSession(id: string, size: TerminalSize): Promise<void> {
    this.ignoredOutputIds.delete(id);
    const handle = this.ensure(id);
    handle.preparing = true;
    // Finish the stopped generation's grid transaction before changing or
    // resetting xterm. This preserves its final buffered output if resume fails
    // and prevents an asynchronous parser callback from crossing generations.
    const settlement = handle.resizeSettling;
    if (settlement) await settlement.done;
    if (this.handles.get(id) !== handle) return;
    // Even without an active resize, callback-less live writes can still be in
    // xterm's parser queue when the stopped status reaches React.
    await this.waitForParserBarrier(id);
    if (this.handles.get(id) !== handle) return;
    // A resumed PTY starts its output sequence at one again.
    this.replayBoundaries.delete(id);
    handle.observedSequence = 0;
    this.observedSequences.set(id, 0);
    handle.gridEpoch = 1;
    // Hold new-generation output until spawn succeeds. A failed resume must
    // leave the previous transcript visible even when saved scrollback arrived.
    handle.resetPending = true;
    handle.preparedOutput = { chunks: [], length: 0 };
    if (handle.retryTimer !== undefined) {
      window.clearTimeout(handle.retryTimer);
      handle.retryTimer = undefined;
    }
    if (handle.term.cols !== size.cols || handle.term.rows !== size.rows) {
      handle.term.resize(size.cols, size.rows);
    }
    handle.appliedSize = size;
    handle.desiredSize = null;
    handle.resizeFailures = 0;
    handle.preparing = false;
  }

  /** Size an empty boot xterm without entering manual-resume transaction state. */
  prepareReplaySession(id: string, size: TerminalSize): void {
    this.ignoredOutputIds.delete(id);
    const handle = this.ensure(id);
    if (handle.term.cols !== size.cols || handle.term.rows !== size.rows) {
      handle.term.resize(size.cols, size.rows);
    }
    handle.appliedSize = size;
    handle.desiredSize = null;
  }

  /** Drop captured output for a session that is stopped after restore completes. */
  discardCapturedOutput(id: string): void {
    this.replayBuffers.delete(id);
    this.replayParsing.delete(id);
    this.replayResolved.add(id);
    this.replayClaims.delete(id);
    this.replayBoundaries.delete(id);
  }

  /** Tombstone a session removed or confirmed stopped by boot reconciliation. */
  ignoreOutput(id: string): void {
    const handle = this.handles.get(id);
    if (handle) {
      if (handle.retryTimer !== undefined) window.clearTimeout(handle.retryTimer);
      handle.resizeSettling?.resolveDone();
      handle.el.remove();
      handle.term.dispose();
    }
    this.handles.delete(id);
    this.pendingOutput.delete(id);
    this.discardCapturedOutput(id);
    this.observedSequences.delete(id);
    this.ignoredOutputIds.add(id);
  }

  /** Undo a deletion tombstone when the backend rejects the delete request. */
  allowOutput(id: string): void {
    this.ignoredOutputIds.delete(id);
  }

  /** Remove every boot-captured ID absent from the authoritative registry. */
  reconcileCapturedOutput(allowedIds: ReadonlySet<string>): string[] {
    const owned = new Set([
      ...this.handles.keys(),
      ...this.pendingOutput.keys(),
      ...this.replayBuffers.keys(),
      ...this.replayParsing.keys(),
    ]);
    const ignored: string[] = [];
    for (const id of owned) {
      if (!allowedIds.has(id)) {
        this.ignoreOutput(id);
        ignored.push(id);
      }
    }
    return ignored;
  }

  /** Commit a successfully spawned PTY generation and its held first output. */
  commitSessionPreparation(id: string): void {
    const handle = this.handles.get(id);
    if (!handle?.resetPending) return;
    const prepared = handle.preparedOutput.chunks;
    handle.term.reset();
    handle.resetPending = false;
    handle.preparedOutput = { chunks: [], length: 0 };
    for (const chunk of prepared) this.writeMeasured(id, chunk);
  }

  /** Roll back preparation when no new PTY generation was created. */
  cancelSessionPreparation(id: string): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    handle.resetPending = false;
    handle.preparedOutput = { chunks: [], length: 0 };
    handle.appliedSize = null;
  }

  focus(id: string): void {
    this.handles.get(id)?.term.focus();
  }

  dispose(id: string): void {
    const h = this.handles.get(id);
    if (h) {
      if (h.retryTimer !== undefined) window.clearTimeout(h.retryTimer);
      h.resizeSettling?.resolveDone();
      h.el.remove();
      h.term.dispose();
    }
    this.handles.delete(id);
    this.pendingOutput.delete(id);
    this.replayBuffers.delete(id);
    this.replayParsing.delete(id);
    this.replayResolved.delete(id);
    this.replayBoundaries.delete(id);
    this.replayClaims.delete(id);
    this.observedSequences.delete(id);
    this.ignoredOutputIds.delete(id);
  }
}
