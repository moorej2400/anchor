import { useMemo, useState, type DragEvent } from "react";
import { Button, Modal, TextInput } from "../components/lib";
import { useAnchor } from "../app/store";
import { sessionsForWorkspace } from "../app/workspaces";
import { DEFAULT_WORKSPACE_ID, type Workspace } from "../ipc/types";

const SESSION_DRAG_TYPE = "application/x-anchor-session";

export function WorkspaceRail() {
  const { state, actions } = useAnchor();
  const [query, setQuery] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () => state.settings.workspaces.filter((workspace) =>
      !workspace.archived && (!normalized || workspace.name.toLocaleLowerCase().includes(normalized))
    ),
    [normalized, state.settings.workspaces],
  );
  const pinned = visible.filter((workspace) => workspace.pinned);
  const others = visible.filter((workspace) => !workspace.pinned);

  if (!state.workspacePaneOpen) return null;

  const renderGroup = (label: string, workspaces: Workspace[]) => workspaces.length > 0 && (
    <section className="workspace-rail__group">
      <div className="workspace-rail__label">{label}</div>
      {workspaces.map((workspace) => (
        <WorkspaceButton key={workspace.id} workspace={workspace} />
      ))}
    </section>
  );

  function WorkspaceButton({ workspace }: { workspace: Workspace }) {
    const count = sessionsForWorkspace(state.sessions, state.settings, workspace.id).length;
    const onDrop = (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const sessionId = event.dataTransfer.getData(SESSION_DRAG_TYPE);
      if (sessionId) void actions.moveSessionToWorkspace(sessionId, workspace.id);
    };
    return (
      <button
        className="workspace-rail__item"
        data-active={workspace.id === state.settings.activeWorkspaceId || undefined}
        onClick={() => void actions.selectWorkspace(workspace.id)}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={onDrop}
      >
        <span className="workspace-rail__folder" aria-hidden="true">▰</span>
        <span className="workspace-rail__name">{workspace.name}</span>
        <span className="workspace-rail__count">{count}</span>
      </button>
    );
  }

  return (
    <>
      <aside className="workspace-rail" aria-label="Workspaces">
        <div className="workspace-rail__head">
          <span>Workspaces</span>
          <button className="flat-icon" aria-label="Manage workspaces" onClick={() => setManageOpen(true)}>•••</button>
        </div>
        <label className="rail-search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find workspace" />
        </label>
        <div className="workspace-rail__list">
          {renderGroup("Pinned", pinned)}
          {renderGroup("Other workspaces", others)}
          {visible.length === 0 && <p className="workspace-rail__empty">No matching workspaces.</p>}
        </div>
        <div className="workspace-rail__actions">
          <button onClick={() => setCreateOpen(true)}>＋ <span>New workspace</span></button>
          <button onClick={() => setManageOpen(true)}>▱ <span>Manage workspaces</span></button>
        </div>
      </aside>
      {createOpen && <CreateWorkspace onClose={() => setCreateOpen(false)} />}
      {manageOpen && <WorkspaceManager onClose={() => setManageOpen(false)} />}
    </>
  );
}

function CreateWorkspace({ onClose }: { onClose: () => void }) {
  const { actions } = useAnchor();
  const [name, setName] = useState("");
  const create = async () => {
    const workspace = await actions.createWorkspace(name);
    if (!workspace) return;
    await actions.selectWorkspace(workspace.id);
    onClose();
  };
  return (
    <Modal onClose={onClose} width={430}>
      <div className="workspace-dialog__head">
        <div><h2>New workspace</h2><p>Keep a focused set of chats, tabs, and favorites.</p></div>
        <button className="flat-icon" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="workspace-dialog__body">
        <label className="workspace-dialog__field">Workspace name
          <TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }} placeholder="Release planning" />
        </label>
      </div>
      <div className="workspace-dialog__footer">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>Create workspace</Button>
      </div>
    </Modal>
  );
}

function WorkspaceManager({ onClose }: { onClose: () => void }) {
  const { state, actions } = useAnchor();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const workspaces = state.settings.workspaces.filter((workspace) =>
    !normalized || workspace.name.toLocaleLowerCase().includes(normalized)
  );
  const commitRename = async (workspace: Workspace) => {
    if (draft.trim() && draft.trim() !== workspace.name) {
      await actions.renameWorkspace(workspace.id, draft);
    }
    setEditingId(null);
  };

  return (
    <Modal onClose={onClose} align="top" topOffset="9vh" width={620}>
      <div className="workspace-dialog__head">
        <div><h2>Your workspaces</h2><p>Switch context, pin frequent work, or archive finished areas.</p></div>
        <button className="flat-icon" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="workspace-manager__tools">
        <label className="rail-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find workspace" /></label>
      </div>
      <div className="workspace-manager__list">
        {workspaces.map((workspace) => {
          const count = sessionsForWorkspace(state.sessions, state.settings, workspace.id).length;
          return (
            <div className="workspace-manager__row" key={workspace.id} data-current={workspace.id === state.settings.activeWorkspaceId || undefined}>
              <button className="workspace-manager__select" onClick={() => {
                if (!workspace.archived) void actions.selectWorkspace(workspace.id);
              }}>
                <span className="workspace-manager__folder">▰</span>
                {editingId === workspace.id ? (
                  <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRename(workspace);
                    if (event.key === "Escape") setEditingId(null);
                  }} onBlur={() => void commitRename(workspace)} />
                ) : <span>{workspace.name}</span>}
                <small>{count} {count === 1 ? "chat" : "chats"}{workspace.archived ? " · archived" : ""}</small>
              </button>
              <div className="workspace-manager__row-actions">
                <button onClick={() => { setEditingId(workspace.id); setDraft(workspace.name); }}>Rename</button>
                <button onClick={() => void actions.toggleWorkspacePinned(workspace.id)}>{workspace.pinned ? "Unpin" : "Pin"}</button>
                <button disabled={workspace.id === DEFAULT_WORKSPACE_ID} onClick={() => void actions.setWorkspaceArchived(workspace.id, !workspace.archived)}>{workspace.archived ? "Restore" : "Archive"}</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="workspace-dialog__footer"><Button variant="subtle" onClick={onClose}>Done</Button></div>
    </Modal>
  );
}

export { SESSION_DRAG_TYPE };
