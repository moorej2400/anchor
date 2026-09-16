/** Flat application toolbar. Folder paths stay out of chrome by design. */
import { useAnchor } from "../app/store";
import { activeWorkspace } from "../app/workspaces";
import { sessionById } from "../app/selectors";

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
        <svg className="chrome__mark" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="2.5" />
          <path d="M12 7.5V20M6 12h12M6 12c0 4 2.2 7 6 8M18 12c0 4-2.2 7-6 8" />
        </svg>
        <span className="chrome__name">Anchor</span>
      </div>
      <div className="chrome__crumb">
        <span>{settings ? "Settings" : workspace.name}</span>
        <span className="chrome__slash">/</span>
        <strong>{settings ? sectionTitle(state.settingsSection) : folder?.name ?? "Sessions"}</strong>
      </div>
      <div className="chrome__actions">
        {settings ? (
          <button className="chrome__button" onClick={() => actions.closeSettings()}>× <span>Close settings</span></button>
        ) : (
          <>
            <button className="chrome__button" onClick={() => actions.openPalette()}>⌕ <span>Search</span><kbd>⌘ K</kbd></button>
            <button className="chrome__button chrome__button--primary" onClick={() => actions.openNewSession()}>＋ <span>New session</span></button>
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
