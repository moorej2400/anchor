/** Shown for a stopped (persisted) session — one click resumes it. */
import { Badge, Button } from "../components/lib";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import { displayModel, folderPathOf, relativeTime } from "../app/display";

export function ResumeCard({ session }: { session: Session }) {
  const { state, actions } = useAnchor();
  const path = folderPathOf(session, state.folders);

  return (
    <div className="resume-wrap">
      <div className="resume-card">
        <div className="resume-card__head">
          <Badge tool={session.tool} scale={1.35} />
          <div>
            <div className="resume-card__title">{session.title}</div>
            <div className="resume-card__path">{path}</div>
          </div>
        </div>
        <div className="resume-card__panel">
          <div className="resume-card__label">
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "rgba(255,255,255,.35)" }} />
            Saved session — ready to resume
          </div>
          <div className="resume-card__grid">
            <span className="k">session id</span>
            <span className="v">{session.cliSessionId ?? "— (will use picker)"}</span>
            <span className="k">model</span>
            <span className="v">{displayModel(session)}</span>
            <span className="k">last active</span>
            <span className="v">{relativeTime(session.lastActiveAt)}</span>
          </div>
        </div>
        <Button variant="primary" block onClick={() => void actions.resume(session.id)} style={{ padding: 13, fontSize: 14 }}>
          ↻ Resume session
        </Button>
        <div className="resume-card__foot">Restored from {state.settings.backupPath}</div>
      </div>
    </div>
  );
}
