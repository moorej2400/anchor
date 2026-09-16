/** Bottom status bar: active session identity and response attention. */
import { AttentionDot, Button } from "../components/lib";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import { sessionDisplayTitle } from "../app/selectors";
import { displayModel, toolName } from "../app/display";

export function StatusBar({ active }: { active: Session | null }) {
  const { state, actions } = useAnchor();
  // Manual Stop is only offered when the tab doesn't auto-stop on close.
  const showStop = active !== null && active.status !== "stopped" && !state.settings.stopOnClose;
  const customHarness = active
    ? state.settings.customHarnesses.find((harness) =>
      harness.id === state.settings.sessionHarnessIds[active.id]
    )
    : null;

  return (
    <div className="statusbar">
      {active && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}>
              {sessionDisplayTitle(active, state.sessions)}
            </div>
            <div className="statusbar__mono" style={{ color: "var(--text-3)" }}>
              {customHarness ? customHarness.name : `${toolName(active.tool)} · ${displayModel(active)}`}
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
            <AttentionDot ready={Boolean(state.unreadResponses[active.id])} size={9} />
            <span style={{ fontSize: 10.5, color: "var(--text-2)" }}>
              {state.unreadResponses[active.id] ? "response ready" : "open"}
            </span>
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
        <span>⌘K</span>
        <span>⌘,</span>
        <span>⌘W</span>
      </div>
    </div>
  );
}
