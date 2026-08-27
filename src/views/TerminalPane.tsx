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
import { Badge, Button } from "../components/lib";
import type { Session } from "../ipc/types";
import type { LaunchError } from "../app/store";
import { useAnchor } from "../app/store";
import { toolName } from "../app/display";
import { isOn } from "../app/selectors";
import type { TerminalManager } from "../app/terminals";
import { ResumeCard } from "./ResumeCard";

export function TerminalPane({ active }: { active: Session | null }) {
  const { state, terminals } = useAnchor();
  // Until replay has been applied at the backend-claimed restore grid, keep
  // only the viewport probe mounted. A session slot would run its fit observer
  // at the current webview width and could change the parser grid too early.
  const liveTabs = state.bootReady
    ? state.openTabs
        .map((id) => state.sessions.find((session) => session.id === id))
        .filter((session): session is Session => Boolean(session && isOn(session.status)))
    : [];
  const activeLiveId = state.bootReady && active && isOn(active.status) ? active.id : null;

  return (
    <div className="terminal-stage">
      <TerminalDeck
        sessions={liveTabs}
        activeId={activeLiveId}
        terminals={terminals}
      />
      {state.launchError ? <LaunchErrorCard error={state.launchError} /> : !active ? <EmptyState /> : !isOn(active.status) ? <ResumeCard session={active} /> : null}
    </div>
  );
}

function LaunchErrorCard({ error }: { error: LaunchError }) {
  const { actions } = useAnchor();

  return (
    <div className="operation-error-wrap">
      <div className="operation-error-card" role="alert">
        <div className="operation-error-card__head">
          <Badge tool={error.tool} scale={1.35} />
          <div>
            <div className="operation-error-card__title">Could not start {toolName(error.tool)}</div>
            <div className="operation-error-card__code">{error.code ?? "LAUNCH_FAILED"}</div>
          </div>
        </div>
        <div className="operation-error-card__message">{error.message}</div>
        {error.isCliNotFound && (
          <div className="operation-error-card__guidance">
            Install {toolName(error.tool)} and ensure it is available on PATH. Then retry the launch.
          </div>
        )}
        <div className="operation-error-card__actions">
          <Button variant="subtle" onClick={actions.dismissLaunchError}>Back</Button>
          <Button variant="primary" onClick={() => void actions.launch(error.tool, error.folderId)}>Retry launch</Button>
        </div>
      </div>
    </div>
  );
}

interface TerminalDeckProps {
  sessions: Session[];
  activeId: string | null;
  terminals: TerminalManager;
}

export function TerminalDeck({
  sessions,
  activeId,
  terminals,
}: TerminalDeckProps) {
  return (
    <div className="terminal-deck">
      <TerminalViewport terminals={terminals} />
      {sessions.map((session) => (
        <TerminalSlot
          key={session.id}
          session={session}
          active={session.id === activeId}
          terminals={terminals}
        />
      ))}
    </div>
  );
}

function TerminalViewport({ terminals }: { terminals: TerminalManager }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    terminals.mountViewport(host);
    return () => terminals.unmountViewport(host);
  }, [terminals]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        terminals.measureViewport();
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [terminals]);

  return <div ref={hostRef} className="terminal-slot" aria-hidden="true" data-terminal-viewport />;
}

function TerminalSlot({
  session,
  active,
  terminals,
}: {
  session: Session;
  active: boolean;
  terminals: TerminalManager;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Layout effect: the slot owns its terminal before the browser paints, so a
  // selection change can never expose another session's terminal.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    terminals.mount(session.id, host);

    return () => terminals.unmount(session.id, host);
  }, [session.id, session.tool, terminals]);

  // Every slot is sized, not just the visible one. A live session in a
  // background tab keeps printing, and its CLI wraps that output to whatever
  // width the PTY reports; leaving it at xterm's default 80x24 while the pane
  // is far wider is what makes a tab look mangled until a window resize
  // reflows it. Slots are laid out identically, so a hidden slot measures the
  // same box the user will see.
  //
  // Fitting measures layout, so mount and every resize notification still
  // share a single animation frame, and only changed dimensions reach the PTY.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        terminals.fit(session.id);
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [session.id, terminals]);

  // Focus follows selection, never sizing: a background slot being refitted
  // must not pull the caret out of the terminal the user is typing into.
  useEffect(() => {
    if (active) terminals.focus(session.id);
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
