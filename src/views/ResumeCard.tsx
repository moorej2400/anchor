/** Shown for a stopped (persisted) session — one click resumes it when its ID is known. */
import { Badge, Button } from "../components/lib";
import type { Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import { displayModel, folderPathOf, relativeTime } from "../app/display";

export function ResumeCard({ session }: { session: Session }) {
  const { state, actions } = useAnchor();
  const path = folderPathOf(session, state.folders);
  const canResume = session.tool === "terminal" || Boolean(session.cliSessionId);
  const error = state.resumeErrors[session.id];
  const activeWriter = session.tool === "codex" && error?.code === "CODEX_ACTIVE_WRITER";

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
            {canResume ? "Saved session — ready to resume" : "Saved session ID unavailable"}
          </div>
          <div className="resume-card__grid">
            <span className="k">session id</span>
            <span className="v">{session.cliSessionId ?? "Unavailable"}</span>
            <span className="k">model</span>
            <span className="v">{displayModel(session)}</span>
            {session.tool === "codex" && (
              <>
                <span className="k">profile</span>
                <span className="v">{session.codexProfile ?? "Default"}</span>
              </>
            )}
            <span className="k">last active</span>
            <span className="v">{relativeTime(session.lastActiveAt)}</span>
          </div>
        </div>
        {!canResume && (
          <div className="resume-card__unavailable" role="status">
            This AI session has no saved CLI session ID. Anchor cannot resume it and will not open a provider session picker.
          </div>
        )}
        {error && (
          <div className="operation-error operation-error--compact" role="alert">
            <div className="operation-error__title">Unable to resume {session.title}</div>
            <div>{error.message}</div>
            {error.isCliNotFound && <div className="operation-error__guidance">Install {session.tool} and ensure it is available on PATH, then retry.</div>}
            {activeWriter && <div className="operation-error__guidance">Codex permits only one writer per conversation. Forking preserves the transcript under a new session ID.</div>}
          </div>
        )}
        {canResume ? (
          <Button variant="primary" block disabled={!state.bootReady} onClick={() => void actions.resume(session.id)} style={{ padding: 13, fontSize: 14 }}>
            ↻ Resume session
          </Button>
        ) : (
          <Button variant="primary" block disabled style={{ padding: 13, fontSize: 14 }}>
            ↻ Resume session
          </Button>
        )}
        {activeWriter && (
          <Button
            variant="subtle"
            block
            onClick={() => void actions.forkCodex(session.id)}
            style={{ marginTop: 9, padding: 11, fontSize: 13 }}
          >
            Fork conversation and continue
          </Button>
        )}
        {(!canResume || error) && (
          <Button
            variant="subtle"
            block
            onClick={() => void actions.launch(session.tool, session.folderId)}
            style={{ marginTop: 9, padding: 11, fontSize: 13 }}
          >
            Start fresh session in this folder
          </Button>
        )}
        <div className="resume-card__foot">Restored from {state.settings.backupPath}</div>
      </div>
    </div>
  );
}
