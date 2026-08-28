/** Bottom status bar: active session identity, session id, status, counts. */
import { Badge, Button, StatusDot } from "../components/lib";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import { sessionDisplayTitle, statusCounts } from "../app/selectors";
import { displayModel, toolName } from "../app/display";
import { STATUS_LABEL } from "../components/lib/tokens";

export function StatusBar({ active }: { active: Session | null }) {
  const { state, actions } = useAnchor();
  const counts = statusCounts(state.sessions);
  // Manual Stop is only offered when the tab doesn't auto-stop on close.
  const showStop = active !== null && active.status !== "stopped" && !state.settings.stopOnClose;

  return (
    <div className="statusbar">
      {active && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <Badge tool={active.tool} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}>
              {sessionDisplayTitle(active, state.sessions)}
            </div>
            <div className="statusbar__mono" style={{ color: "var(--text-3)" }}>
              {toolName(active.tool)} · {displayModel(active)}
            </div>
          </div>
          <div className="statusbar__id">
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)" }}>session</span>
            <span className="statusbar__mono">{active.cliSessionId ?? "—"}</span>
            {active.cliSessionId && (
              <span style={{ color: "var(--text-3)", fontSize: 11, cursor: "pointer" }} onClick={() => actions.copy(active.cliSessionId!, "Session ID copied")}>⧉</span>
            )}
          </div>
          <div className="statusbar__state">
            <StatusDot status={active.status} size={9} />
            <span style={{ fontSize: 10.5, color: "var(--text-2)", textTransform: "capitalize" }}>{STATUS_LABEL[active.status]}</span>
          </div>
          {showStop && (
            <Button variant="danger" onClick={() => void actions.stop(active.id)} style={{ padding: "4px 11px", fontSize: 11 }}>
              ■ Stop
            </Button>
          )}
        </div>
      )}
      <div className="statusbar__spacer" />
      <div className="statusbar__meta">
        <span style={{ color: "var(--text-2)" }}>{counts.running} running</span>
        <span style={{ color: "#d4a35f" }}>{counts.waiting} waiting</span>
        <span>⌘K</span>
        <span>⌘,</span>
        <span>⌘W</span>
      </div>
    </div>
  );
}
