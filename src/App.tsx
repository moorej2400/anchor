/**
 * Anchor app shell — composes the window chrome, sidebar, main pane (terminal
 * view or settings), overlays, and global keyboard shortcuts. Built to the mock
 * at docs/Anchor.dc.html; all data flows through the store (src/app/store).
 */
import { useCallback, useEffect, useState } from "react";
import { Toast } from "./components/lib";
import type { Folder } from "./ipc/types";
import { useAnchor } from "./app/store";
import { sessionById } from "./app/selectors";
import { folderPathOf } from "./app/display";
import { WindowChrome } from "./views/WindowChrome";
import { Sidebar } from "./views/Sidebar";
import { TabStrip } from "./views/TabStrip";
import { TerminalPane } from "./views/TerminalPane";
import { StatusBar } from "./views/StatusBar";
import { Settings } from "./views/Settings";
import { CommandPalette } from "./views/CommandPalette";
import { NewSessionDialog } from "./views/NewSessionDialog";
import { RemoveFolderModal } from "./views/RemoveFolderModal";
import { CloseSessionModal } from "./views/CloseSessionModal";
import { CodexProfileModal } from "./views/CodexProfileModal";
import { SessionIdModal } from "./views/SessionIdModal";

export default function App() {
  const { state, actions } = useAnchor();
  const [removeTarget, setRemoveTarget] = useState<Folder | null>(null);
  const [codexProfileTarget, setCodexProfileTarget] = useState<string | null>(null);
  const [sessionIdTarget, setSessionIdTarget] = useState<string | null>(null);
  const active = sessionById(state.sessions, state.activeId);
  const profileTarget = sessionById(state.sessions, codexProfileTarget);
  const idTarget = sessionById(state.sessions, sessionIdTarget);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === "k") { e.preventDefault(); state.paletteOpen ? actions.closePalette() : actions.openPalette(); return; }
      if (mod && e.key === ",") { e.preventDefault(); actions.openSettings(); return; }
      if (mod && key === "w") { e.preventDefault(); if (state.activeId) void actions.closeTab(state.activeId); return; }
      if (mod && key === "f") { e.preventDefault(); document.getElementById("anchor-filter")?.focus(); return; }
      if (mod && key === "t") { e.preventDefault(); const f = folderForNew(); if (f) void actions.launch("terminal", f.id); return; }
      if (mod && key === "o") { e.preventDefault(); actions.openNewSession(); return; }
      if (mod && e.key === "Enter") { e.preventDefault(); if (active && active.status === "stopped") void actions.resume(active.id); return; }
      if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; }
      // The close confirmation is a Modal, which owns its own Escape handling.
      if (e.key === "Escape") { setRemoveTarget(null); actions.closePalette(); actions.closeNewSession(); }

      function folderForNew(): Folder | undefined {
        return active ? state.folders.find((f) => f.id === active.folderId) ?? state.folders[0] : state.folders[0];
      }
      function cycleTab(dir: number) {
        const tabs = state.openTabs;
        if (tabs.length === 0 || !state.activeId) return;
        const i = tabs.indexOf(state.activeId);
        const next = tabs[(i + dir + tabs.length) % tabs.length];
        if (next) actions.selectSession(next);
      }
    },
    [state, actions, active],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  if (state.fatalError) {
    return (
      <div className="app">
        <WindowChrome activePath={null} />
        <div className="fatal">Failed to reach the Anchor core:<br />{state.fatalError}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <WindowChrome activePath={active ? folderPathOf(active, state.folders) : null} />
      <div className="app__body">
        <Sidebar onRemoveFolder={setRemoveTarget} onSetCodexProfile={setCodexProfileTarget} onSetSessionId={setSessionIdTarget} />
        <main className="main">
          {state.view === "terminal" ? (
            <div className="term-view">
              <TabStrip />
              <div className="pane-wrap">
                <div className="pane">
                  <TerminalPane active={active} />
                </div>
              </div>
              <StatusBar active={active} />
            </div>
          ) : (
            <Settings />
          )}
        </main>
      </div>

      <CommandPalette />
      <NewSessionDialog />
      {removeTarget && <RemoveFolderModal folder={removeTarget} onClose={() => setRemoveTarget(null)} />}
      {state.closeConfirmId && <CloseSessionModal />}
      {profileTarget && <CodexProfileModal session={profileTarget} onClose={() => setCodexProfileTarget(null)} />}
      {idTarget && <SessionIdModal session={idTarget} onClose={() => setSessionIdTarget(null)} />}
      {state.toast && <Toast text={state.toast} />}
    </div>
  );
}
