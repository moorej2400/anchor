/**
 * New-session wizard, built to docs/Anchor.dc.html.
 *
 * Three steps:
 *   folder — pick a folder Anchor already knows, or add one
 *   create — name a project; Anchor makes the folder in settings.projectsDir
 *   tool   — pick the CLI to launch
 *
 * "Choose an existing folder…" opens the OS folder picker (Finder on macOS)
 * rather than an in-app browser, then registers whatever comes back.
 *
 * Opening from a folder's quick-launch `+` skips straight to `tool`; opening
 * from the tab strip or ⌘O starts at `folder`, which is what makes a cold start
 * with no folders recoverable.
 */
import { useEffect, useRef, useState } from "react";
import { Badge, Modal } from "../components/lib";
import { ipc } from "../ipc/commands";
import type { Folder, Tool } from "../ipc/types";
import { useAnchor } from "../app/store";
import { LAUNCHABLE, toolName } from "../app/display";

type Step = "folder" | "create" | "tool";

export function NewSessionDialog() {
  const { state, actions } = useAnchor();
  const { newSessionOpen, folders, sessions, settings } = state;

  const [step, setStep] = useState<Step>("folder");
  const [folder, setFolder] = useState<Folder | null>(null);
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const projectRef = useRef<HTMLInputElement>(null);

  // Each open starts fresh: a preselected folder goes straight to the tool step.
  useEffect(() => {
    if (!newSessionOpen) return;
    const preselected = state.newSessionFolderId
      ? folders.find((f) => f.id === state.newSessionFolderId) ?? null
      : null;
    setFolder(preselected);
    setStep(preselected ? "tool" : "folder");
    setProjectName("");
    setBusy(false);
    // Only re-init on open, not on every folder-list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSessionOpen, state.newSessionFolderId]);

  if (!newSessionOpen) return null;

  const close = () => actions.closeNewSession();
  const useFolder = (f: Folder) => {
    setFolder(f);
    setStep("tool");
  };

  const back = () => setStep("folder");
  const showBack = step === "create" || (step === "tool" && !state.newSessionFolderId);

  const title =
    step === "folder" ? "Choose a folder"
    : step === "create" ? "Create a new project"
    : "New session";
  const subtitle =
    step === "folder" ? "Where should this session run?"
    : step === "create" ? settings.projectsDir
    : (folder?.path ?? "");

  /** Native folder picker → register (or reuse) → tool step. */
  const browse = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const path = await ipc.pickFolder();
      if (!path) return; // cancelled — stay on the folder step
      const existing = folders.find((f) => f.path === path);
      const next = existing ?? (await actions.addFolder(path));
      if (next) useFolder(next);
    } catch (e) {
      actions.toast(String(e).replace(/^[A-Z_]+: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const goCreate = () => {
    setStep("create");
    window.setTimeout(() => projectRef.current?.focus(), 0);
  };

  const submitProject = async () => {
    const name = projectName.trim();
    if (!name || busy) return;
    setBusy(true);
    const next = await actions.createProject(name);
    setBusy(false);
    if (next) useFolder(next);
  };

  const launch = (tool: Tool) => {
    if (!folder) return;
    close();
    void actions.launch(tool, folder.id);
  };

  return (
    <Modal onClose={close} align="top" width={500}>
      <div className="nt__head">
        {showBack && <button className="nt__back" title="Back" onClick={back}>←</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="dialog__title">{title}</div>
          <div className="dialog__sub">{subtitle}</div>
        </div>
      </div>

      {step === "folder" && (
        <div className="nt__body">
          {folders.length > 0 && (
            <>
              <div className="nt__label">Folders already in Anchor</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {folders.map((f) => {
                  const count = sessions.filter((s) => s.folderId === f.id).length;
                  return (
                    <button key={f.id} className="nt__row" onClick={() => useFolder(f)}>
                      <span className="nt__chip" />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="nt__rowTitle">{f.name}</span>
                        <span className="nt__rowPath">{f.path}</span>
                      </span>
                      <span className="nt__count">
                        {count === 0 ? "no sessions" : count === 1 ? "1 session" : `${count} sessions`}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="a-menu__divider" style={{ margin: "9px 7px" }} />
            </>
          )}

          <div className="nt__label">Add a folder</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <button className="nt__row" onClick={() => void browse()} disabled={busy}>
              <span className="nt__icon">⌕</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="nt__rowTitle" style={{ fontSize: 13.5 }}>Choose an existing folder…</span>
                <span className="nt__rowSub">Browse your Mac and point Anchor at any directory</span>
              </span>
              <span className="nt__kbd">⌘O</span>
            </button>
            <button className="nt__row" onClick={goCreate}>
              <span className="nt__icon nt__icon--grad">+</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="nt__rowTitle" style={{ fontSize: 13.5 }}>Create a new project</span>
                <span className="nt__rowPath">Anchor makes the folder in {settings.projectsDir}</span>
              </span>
            </button>
          </div>
        </div>
      )}

      {step === "create" && (
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>Project name</div>
          <input
            ref={projectRef}
            className="a-input"
            value={projectName}
            placeholder="my-new-project"
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitProject();
            }}
            style={{ padding: "11px 12px" }}
          />
          <div className="nt__willCreate">
            <div className="nt__footLabel">Will be created at</div>
            <div className="nt__createPath">
              {settings.projectsDir}/{projectName.trim() || "…"}
            </div>
          </div>
          <div className="nt__createNote">
            No file picker needed — Anchor creates the folder inside your projects directory.
            Change that location in <span style={{ color: "rgba(255,255,255,.7)" }}>Settings › General</span>.
          </div>
          <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
            <button className="a-btn a-btn--subtle a-btn--block" onClick={back} style={{ padding: "10px 0" }}>
              Back
            </button>
            <button
              className="a-btn a-btn--primary a-btn--block"
              style={{ padding: "10px 0" }}
              disabled={!projectName.trim() || busy}
              onClick={() => void submitProject()}
            >
              Create project
            </button>
          </div>
        </div>
      )}

      {step === "tool" && folder && (
        <>
          <div className="nt__folderBar">
            <div className="nt__label" style={{ padding: 0, marginBottom: 8 }}>Folder</div>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span className="nt__chip" style={{ width: 10, height: 10 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="nt__rowTitle" style={{ fontSize: 13.5, fontWeight: 600 }}>{folder.name}</span>
                <span className="nt__rowPath">{folder.path}</span>
              </span>
              <button className="nt__change" onClick={() => setStep("folder")}>Change</button>
            </div>
          </div>
          <div className="dialog__body">
            {LAUNCHABLE.map((tool) => (
              <div key={tool}>
                {tool === "terminal" && <div className="a-menu__divider" style={{ margin: "6px 7px" }} />}
                <button className="tool-item" onClick={() => launch(tool)}>
                  <Badge tool={tool} style={{ width: 26, height: 26, borderRadius: 7, fontSize: 11 }} />
                  {tool === "terminal" ? "Generic terminal" : toolName(tool)}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
