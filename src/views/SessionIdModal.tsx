/** Manually attaches a known provider conversation ID to a stopped session. */
import { useEffect, useState } from "react";
import { Button, Modal, TextInput } from "../components/lib";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";

export function SessionIdModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const { actions } = useAnchor();
  const [sessionId, setSessionId] = useState(session.cliSessionId ?? "");
  const canSave = sessionId.trim().length > 0;

  useEffect(() => {
    setSessionId(session.cliSessionId ?? "");
  }, [session.id, session.cliSessionId]);

  const save = async () => {
    if (canSave && await actions.setSessionId(session.id, sessionId.trim())) onClose();
  };

  return (
    <Modal onClose={onClose} width={460}>
      <div className="codex-profile">
        <div className="dialog__head">
          <div className="dialog__title">Set session ID</div>
          <div className="dialog__sub">Used for the next provider resume</div>
        </div>
        <div className="codex-profile__body">
          <label className="codex-profile__label" htmlFor="provider-session-id">Provider session ID</label>
          <TextInput
            id="provider-session-id"
            className="a-input--mono"
            autoFocus
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            placeholder="Paste the provider session ID"
          />
          <div className="codex-profile__note">
            This changes which provider conversation opens when this Anchor session resumes.
          </div>
          <div className="codex-profile__actions">
            <Button variant="subtle" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} onClick={() => void save()}>Save session ID</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
