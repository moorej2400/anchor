/**
 * Main pane. Shows, for the active tab: the live xterm terminal (ON sessions),
 * the Resume card (stopped/persisted sessions), or the empty state (no tabs).
 *
 * Every open ON session owns one stable slot in the deck for the lifetime of
 * its tab (SPEC.md §8). Selecting a session only changes which slot is visible;
 * no terminal is ever reparented, so the visible terminal always matches
 * `activeId` by the next paint.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { ipc } from "../ipc/commands";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import { isOn } from "../app/selectors";
import type { TerminalManager } from "../app/terminals";
import { ResumeCard } from "./ResumeCard";

export function TerminalPane({ active }: { active: Session | null }) {
  const { state, terminals } = useAnchor();
  const liveTabs = state.openTabs
    .map((id) => state.sessions.find((session) => session.id === id))
    .filter((session): session is Session => Boolean(session && isOn(session.status)));
  const activeLiveId = active && isOn(active.status) ? active.id : null;

  return (
    <div className="terminal-stage">
      <TerminalDeck
        sessions={liveTabs}
        activeId={activeLiveId}
        terminals={terminals}
        restoreScrollback={state.settings.restoreScrollback}
      />
      {!active ? <EmptyState /> : !isOn(active.status) ? <ResumeCard session={active} /> : null}
    </div>
  );
}

interface TerminalDeckProps {
  sessions: Session[];
  activeId: string | null;
  terminals: TerminalManager;
  /** Prime a terminal session's saved scrollback on its first mount. */
  restoreScrollback?: boolean;
}

export function TerminalDeck({
  sessions,
  activeId,
  terminals,
  restoreScrollback = false,
}: TerminalDeckProps) {
  return (
    <div className="terminal-deck">
      {sessions.map((session) => (
        <TerminalSlot
          key={session.id}
          session={session}
          active={session.id === activeId}
          terminals={terminals}
          restoreScrollback={restoreScrollback}
        />
      ))}
    </div>
  );
}

function TerminalSlot({
  session,
  active,
  terminals,
  restoreScrollback,
}: {
  session: Session;
  active: boolean;
  terminals: TerminalManager;
  restoreScrollback: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Layout effect: the slot owns its terminal before the browser paints, so a
  // selection change can never expose another session's terminal.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const justOpened = terminals.mount(session.id, host);

    if (justOpened && session.tool === "terminal" && restoreScrollback) {
      void ipc
        .getScrollback(session.id)
        .then((text) => {
          if (!text) return;
          const lines = text.split("\n").length;
          terminals.write(
            session.id,
            `\x1b[2m── restored session · scrollback recovered (${lines.toLocaleString()} lines) ──\x1b[0m\r\n${text}`,
          );
        })
        .catch(() => {});
    }

    return () => terminals.unmount(session.id, host);
    // `restoreScrollback` is read only on the mount that opens the terminal;
    // re-running for a settings change would not re-prime anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.tool, terminals]);

  // Fitting measures layout, so activation and every resize notification share
  // a single animation frame and only changed dimensions reach the PTY.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const dims = terminals.fit(session.id);
        if (dims) {
          void ipc.resizePty(session.id, dims.cols, dims.rows).catch(() => {});
        }
        terminals.focus(session.id);
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, session.id, terminals]);

  return (
    <div
      ref={hostRef}
      className="terminal-slot"
      data-terminal-active={active ? "true" : "false"}
      data-terminal-session-id={session.id}
      aria-hidden={!active}
    />
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div>
        <div className="empty__mark" />
        <div className="empty__title">No session open</div>
        <div style={{ fontSize: 12.5 }}>
          Press <span className="mini-kbd">⌘K</span> or use <span style={{ color: "var(--text-2)" }}>+</span> next to a folder to launch one.
        </div>
      </div>
    </div>
  );
}
