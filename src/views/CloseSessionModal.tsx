/**
 * Confirmation for closing a live session's tab (`confirmClose`).
 *
 * A modal rather than a popover anchored to the tab: the tab strip scrolls and
 * clips its overflow, and ⌘W can target a tab that is scrolled out of view, so
 * an anchored prompt would be clipped or attached to nothing.
 */
import { Modal } from "../components/lib";
import { useAnchor } from "../app/store";
import { sessionById, sessionDisplayTitle } from "../app/selectors";

export function CloseSessionModal() {
  const { state, actions } = useAnchor();
  const session = sessionById(state.sessions, state.closeConfirmId);
  if (!session) return null;

  return (
    <Modal onClose={() => actions.cancelCloseTab()} align="center" width={420}>
      <div className="remove-modal">
        <div className="remove-modal__head">
          <div className="remove-modal__icon">⚠</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            Close “{sessionDisplayTitle(session, state.sessions)}”?
          </div>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-2)", marginBottom: 18 }}>
          {state.settings.stopOnClose
            ? "Its running process will be stopped. The saved session ID is kept, so you can resume it later."
            : "Its process keeps running in the background; only the tab closes."}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="a-btn a-btn--subtle a-btn--block"
            style={{ padding: "11px 0" }}
            onClick={() => actions.cancelCloseTab()}
          >
            Cancel
          </button>
          <button
            className="a-btn a-btn--danger a-btn--block"
            style={{ padding: "11px 0", fontWeight: 700 }}
            onClick={() => void actions.confirmCloseTab()}
          >
            Close session
          </button>
        </div>
      </div>
    </Modal>
  );
}
