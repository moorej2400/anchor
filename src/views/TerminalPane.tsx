/**
 * Main pane. Shows, for the active tab: the live xterm terminal (ON sessions),
 * the Resume card (stopped/persisted sessions), or the empty state (no tabs).
 * Terminal instances are owned by the TerminalManager and survive tab switches.
 */
import { useEffect, useRef } from "react";
import { ipc } from "../ipc/commands";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import { isOn } from "../app/selectors";
import { ResumeCard } from "./ResumeCard";

export function TerminalPane({ active }: { active: Session | null }) {
  if (!active) return <EmptyState />;
  if (!isOn(active.status)) return <ResumeCard session={active} />;
  return <TerminalSurface session={active} />;
}

function TerminalSurface({ session }: { session: Session }) {
  const { terminals, state } = useAnchor();
  const ref = useRef<HTMLDivElement>(null);
  const restoreScrollback = state.settings.restoreScrollback;

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    const justOpened = terminals.attach(session.id, host);
    terminals.focus(session.id);

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

    const syncSize = () => {
      const dims = terminals.fit(session.id);
      if (dims) void ipc.resizePty(session.id, dims.cols, dims.rows).catch(() => {});
    };
    syncSize();
    window.addEventListener("resize", syncSize);
    const ro = new ResizeObserver(syncSize);
    ro.observe(host);
    return () => {
      window.removeEventListener("resize", syncSize);
      ro.disconnect();
    };
    // Re-run when the active session changes; terminal instances persist in the manager.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return <div className="term-host"><div ref={ref} style={{ width: "100%", height: "100%" }} /></div>;
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
