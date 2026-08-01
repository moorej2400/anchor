/** Selects the configuration profile a stopped Codex session will use next. */
import { useEffect, useState } from "react";
import { Button, Modal } from "../components/lib";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";

interface CodexProfileModalProps {
  session: Session;
  onClose: () => void;
}

export function CodexProfileModal({ session, onClose }: CodexProfileModalProps) {
  const { state, actions } = useAnchor();
  const [profile, setProfile] = useState(session.codexProfile ?? "");
  const available = state.codexProfiles.includes(session.codexProfile ?? "");
  const unavailable = Boolean(session.codexProfile) && !available;
  const canSave = profile === "" || state.codexProfiles.includes(profile);

  useEffect(() => {
    setProfile(session.codexProfile ?? "");
  }, [session.id, session.codexProfile]);

  const save = async () => {
    if (!canSave) return;
    if (await actions.setCodexProfile(session.id, profile || null)) onClose();
  };

  return (
    <Modal onClose={onClose} width={420}>
      <div className="codex-profile">
        <div className="dialog__head">
          <div className="dialog__title">Codex profile</div>
          <div className="dialog__sub">Used the next time this session resumes</div>
        </div>
        <div className="codex-profile__body">
          <label className="codex-profile__label" htmlFor="codex-profile-select">Profile</label>
          <select
            id="codex-profile-select"
            className="a-input a-input--mono codex-profile__select"
            aria-label="Codex profile"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            {unavailable && (
              <option value={session.codexProfile ?? ""} disabled>
                {session.codexProfile} (unavailable)
              </option>
            )}
            <option value="">Default profile</option>
            {state.codexProfiles.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          {unavailable && (
            <div className="codex-profile__error" role="alert">
              The saved profile is not available. Choose an available profile before the next resume.
            </div>
          )}
          <div className="codex-profile__note">
            Anchor saves this choice with the session. It does not change your system default.
          </div>
          <div className="codex-profile__actions">
            <Button variant="subtle" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} onClick={() => void save()}>Save profile</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
