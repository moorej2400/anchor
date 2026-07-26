/** Destructive confirm modal for removing a folder group and its sessions. */
import { useState } from "react";
import { Modal } from "../components/lib";
import type { Folder } from "../ipc/types";
import { useAnchor } from "../app/store";

export function RemoveFolderModal({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const { state, actions } = useAnchor();
  const [ack, setAck] = useState(false);
  const count = state.sessions.filter((s) => s.folderId === folder.id).length;

  return (
    <Modal onClose={onClose} align="center">
      <div className="remove-modal">
        <div className="remove-modal__head">
          <div className="remove-modal__icon">⚠</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Remove “{folder.name}”?</div>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-2)", marginBottom: 18 }}>
          This permanently removes the group and its <b style={{ color: "rgba(255,255,255,.85)" }}>{count}</b> saved session(s) — including their persisted session IDs. This can’t be undone.
        </div>
        <div className="remove-modal__ack" onClick={() => setAck((a) => !a)}>
          <span className="checkbox" data-on={ack}>{ack ? "✓" : ""}</span>
          <span style={{ fontSize: 12.5, color: "rgba(255,255,255,.82)" }}>I understand these sessions will be deleted</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="a-btn a-btn--subtle a-btn--block" style={{ padding: "11px 0" }} onClick={onClose}>Cancel</button>
          {ack ? (
            <button
              className="a-btn a-btn--danger a-btn--block"
              style={{ padding: "11px 0", fontWeight: 700 }}
              onClick={() => { void actions.removeFolder(folder.id); onClose(); }}
            >
              Remove group
            </button>
          ) : (
            <div className="a-btn a-btn--block" style={{ padding: "11px 0", color: "var(--text-3)", cursor: "not-allowed", opacity: 0.6 }}>Remove group</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
