/** New-session dialog — pick a tool to launch in the active folder. */
import { Badge, Modal } from "../components/lib";
import { useAnchor } from "../app/store";
import { sessionById } from "../app/selectors";
import { LAUNCHABLE, toolName } from "../app/display";

export function NewSessionDialog() {
  const { state, actions } = useAnchor();
  if (!state.newSessionOpen) return null;

  const active = sessionById(state.sessions, state.activeId);
  const folder = active
    ? state.folders.find((f) => f.id === active.folderId) ?? state.folders[0]
    : state.folders[0];

  if (!folder) {
    // No folders yet — nothing to launch into.
    return (
      <Modal onClose={() => actions.closeNewSession()} align="top" width={440}>
        <div className="dialog__head">
          <div className="dialog__title">New session</div>
          <div className="dialog__sub">Add a folder first to launch a session.</div>
        </div>
      </Modal>
    );
  }

  const launch = (tool: (typeof LAUNCHABLE)[number]) => {
    actions.closeNewSession();
    void actions.launch(tool, folder.id);
  };

  return (
    <Modal onClose={() => actions.closeNewSession()} align="top" width={440}>
      <div className="dialog__head">
        <div className="dialog__title">New session</div>
        <div className="dialog__sub">in {folder.name}</div>
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
    </Modal>
  );
}
