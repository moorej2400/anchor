/** Flat application toolbar. Folder paths stay out of chrome by design. */
import { useAnchor } from "../app/store";
import { activeWorkspace } from "../app/workspaces";
import { sessionById } from "../app/selectors";
import { Icon } from "../components/Icon";

export function WindowChrome() {
  const { state, actions } = useAnchor();
  const workspace = activeWorkspace(state.settings);
  const active = sessionById(state.sessions, state.activeId);
  const folder = active ? state.folders.find((item) => item.id === active.folderId) : null;
  const settings = state.view === "settings";
  return (
    <div
      className="chrome"
      data-tauri-drag-region
      data-workspace-rail={!settings && state.workspacePaneOpen || undefined}
      data-settings={settings || undefined}
    >
      <div className="chrome__brand">
        <Icon name="anchor" size={20} className="chrome__mark" />
        <span className="chrome__name">Anchor</span>
      </div>
      <div className="chrome__crumb">
        <span>{settings ? "Settings" : workspace.name}</span>
        <span className="chrome__slash">/</span>
        <strong>{settings ? sectionTitle(state.settingsSection) : folder?.name ?? "Sessions"}</strong>
      </div>
      <div className="chrome__actions">
        {settings ? (
          <button className="chrome__button" onClick={() => actions.closeSettings()}><Icon name="close" size={13} /> <span>Close settings</span></button>
        ) : (
          <>
            <button className="chrome__button" onClick={() => actions.openPalette()}><Icon name="search" size={13} /> <span>Search</span><kbd>⌘ K</kbd></button>
            <button className="chrome__button chrome__button--primary" aria-label="New session from toolbar" onClick={() => actions.openNewSession()}><Icon name="plus" size={13} /> <span>New session</span></button>
          </>
        )}
      </div>
    </div>
  );
}

function sectionTitle(section: string): string {
  return {
    general: "General",
    appearance: "Appearance",
    notifications: "Notifications",
    terminal: "Terminal",
    harnesses: "Harnesses",
    persistence: "Persistence & backup",
    shortcuts: "Keyboard shortcuts",
    about: "About",
  }[section] ?? "General";
}
