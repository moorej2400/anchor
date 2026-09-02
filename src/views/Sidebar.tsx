/**
 * Left sidebar: filter, folder groups (collapse, rename, quick-launch, remove),
 * session rows (select, rename, delete, copy id), and the status legend footer.
 * Ephemeral popover/hover/rename state is local; domain mutations go to the store.
 * Built to docs/Anchor.dc.html.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  MenuLabel,
  SidebarRow,
  StatusDot,
  TextInput,
} from "../components/lib";
import type { Folder, Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import { foldersWithSessions, sessionDisplayTitle, statusCounts } from "../app/selectors";
import { LAUNCHABLE, toolName } from "../app/display";

interface SidebarProps {
  onRemoveFolder: (folder: Folder) => void;
  onSetCodexProfile: (sessionId: string) => void;
}

export function Sidebar({ onRemoveFolder, onSetCodexProfile }: SidebarProps) {
  const { state, actions } = useAnchor();
  // Selecting a tab changes `activeId` only. Without memoizing, every selection
  // would re-filter and re-sort every session before the terminal can paint.
  const groups = useMemo(
    () => foldersWithSessions(state.folders, state.sessions, state.filter, state.typedOrder),
    [state.folders, state.sessions, state.filter, state.typedOrder],
  );
  const counts = useMemo(() => statusCounts(state.sessions), [state.sessions]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Only one menu/popover open at a time (mock behavior).
  const [ui, setUi] = useState<{
    folderMenu: string | null; // quick-launch (+)
    folderMore: string | null; // ⋯ options
    folderRename: string | null;
    sessionMenu: string | null;
    sessionRename: string | null;
    confirmDelete: string | null;
  }>({ folderMenu: null, folderMore: null, folderRename: null, sessionMenu: null, sessionRename: null, confirmDelete: null });
  const closeAllMenus = () =>
    setUi((u) => ({ ...u, folderMenu: null, folderMore: null, sessionMenu: null, confirmDelete: null }));

  // Click anywhere closes open menus; menus themselves stopPropagation.
  useEffect(() => {
    const onDoc = () => closeAllMenus();
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar__filter">
        <div className="filter-box">
          <span className="filter-box__glyph">⌕</span>
          <TextInput
            id="anchor-filter"
            variant="seamless"
            value={state.filter}
            onChange={(e) => actions.setFilter(e.target.value)}
            placeholder="Filter sessions & folders"
            style={{ fontSize: 12.5 }}
          />
          <button className="kbd-chip" onClick={(e) => { e.stopPropagation(); actions.openPalette(); }}>
            ⌘K
          </button>
        </div>
      </div>

      <div className="sidebar__list">
        {groups.map((folder) => (
          <FolderGroup
            key={folder.id}
            folder={folder}
            activeId={state.activeId}
            collapsed={!!collapsed[folder.id]}
            ui={ui}
            setUi={setUi}
            onToggle={() => setCollapsed((c) => ({ ...c, [folder.id]: !c[folder.id] }))}
            onRemoveFolder={onRemoveFolder}
            onSetCodexProfile={onSetCodexProfile}
          />
        ))}
      </div>

      <div className="sidebar__footer">
        <div className="legend">
          <span className="legend__item">
            <span className="legend__dot" style={{ background: "#5fb891", boxShadow: "0 0 6px rgba(95,184,145,.6)" }} />
            {counts.running} running
          </span>
          <span className="legend__item">
            <span className="legend__dot" style={{ background: "#d4a35f", boxShadow: "0 0 6px rgba(212,163,95,.6)" }} />
            {counts.waiting} waiting
          </span>
          <span className="legend__item" style={{ color: "var(--text-3)" }}>{counts.stopped} stopped</span>
        </div>
        <Button variant="subtle" block onClick={() => actions.openSettings()} style={{ justifyContent: "flex-start" }}>
          <span style={{ fontSize: 14 }}>⚙</span>Settings
        </Button>
      </div>
    </aside>
  );
}

type Ui = Parameters<typeof FolderGroup>[0]["ui"];
type SetUi = Parameters<typeof FolderGroup>[0]["setUi"];

function FolderGroup(props: {
  folder: Folder & { sessions: Session[] };
  activeId: string | null;
  collapsed: boolean;
  ui: {
    folderMenu: string | null;
    folderMore: string | null;
    folderRename: string | null;
    sessionMenu: string | null;
    sessionRename: string | null;
    confirmDelete: string | null;
  };
  setUi: React.Dispatch<React.SetStateAction<{
    folderMenu: string | null;
    folderMore: string | null;
    folderRename: string | null;
    sessionMenu: string | null;
    sessionRename: string | null;
    confirmDelete: string | null;
  }>>;
  onToggle: () => void;
  onRemoveFolder: (folder: Folder) => void;
  onSetCodexProfile: (sessionId: string) => void;
}) {
  const { folder, activeId, collapsed, ui, setUi, onToggle, onRemoveFolder, onSetCodexProfile } = props;
  const { state, actions } = useAnchor();
  const [hover, setHover] = useState(false);
  const [renameDraft, setRenameDraft] = useState(folder.name);
  const renameRef = useRef<HTMLInputElement>(null);

  const expanded = !collapsed && folder.sessions.length > 0;
  const renaming = ui.folderRename === folder.id;
  const showMore = (hover || ui.folderMore === folder.id) && !renaming;
  // Quick-launch stays visible while its own menu is open, so moving the
  // pointer into the menu doesn't make the button it belongs to disappear.
  const showAdd = (hover || ui.folderMenu === folder.id) && !renaming;

  useEffect(() => {
    if (renaming) {
      setRenameDraft(folder.name);
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming, folder.name]);

  const commitRename = () => {
    const name = renameDraft.trim() || "untitled";
    if (name !== folder.name) void actions.renameFolder(folder.id, name);
    setUi((u) => ({ ...u, folderRename: null }));
  };

  return (
    <div className="folder" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="folder__head">
        {renaming ? (
          <TextInput
            ref={renameRef}
            variant="inline"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") { e.stopPropagation(); setUi((u) => ({ ...u, folderRename: null })); }
            }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            style={{ fontSize: 14.5, fontWeight: 400 }}
          />
        ) : (
          <button
            className="folder__name"
            aria-expanded={expanded}
            aria-controls={`folder-sessions-${folder.id}`}
            onClick={onToggle}
          >
            {folder.name}
          </button>
        )}
        <span className="folder__count">{folder.sessions.length}</span>
        {/* Both stay laid out (hidden, not unmounted) so revealing them on
            hover never reflows the header's name or count. */}
        <IconButton
          aria-label="Folder options"
          size={20}
          tabIndex={showMore ? 0 : -1}
          style={{ fontSize: 15, visibility: showMore ? "visible" : "hidden" }}
          onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, folderMore: u.folderMore === folder.id ? null : folder.id, folderMenu: null, sessionMenu: null })); }}
        >
          ⋯
        </IconButton>
        <IconButton
          bordered
          className="a-plus"
          aria-label="Quick launch"
          size={20}
          tabIndex={showAdd ? 0 : -1}
          style={{ fontSize: 14, visibility: showAdd ? "visible" : "hidden" }}
          onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, folderMenu: u.folderMenu === folder.id ? null : folder.id, folderMore: null, sessionMenu: null })); }}
        >
          +
        </IconButton>

        {ui.folderMore === folder.id && (
          <Menu width={206} style={{ top: 30, right: 8 }}>
            <MenuItem icon="✎" onClick={() => setUi((u) => ({ ...u, folderRename: folder.id, folderMore: null }))}>Rename group</MenuItem>
            <MenuItem icon="⧉" onClick={() => { actions.copy(folder.path, "Folder path copied"); setUi((u) => ({ ...u, folderMore: null })); }}>Copy folder path</MenuItem>
            <MenuDivider />
            <MenuItem danger icon="✕" onClick={() => { setUi((u) => ({ ...u, folderMore: null })); onRemoveFolder(folder); }}>Remove group</MenuItem>
          </Menu>
        )}

        {ui.folderMenu === folder.id && (
          <Menu width={236} style={{ top: 30, right: 6 }}>
            <MenuLabel>Launch in {folder.name}</MenuLabel>
            {LAUNCHABLE.map((tool) => {
              if (tool === "codex" && state.codexProfiles.length > 1) {
                return state.codexProfiles.map((profile) => (
                  <MenuItem
                    key={`${tool}-${profile}`}
                    icon={<Badge tool={tool} />}
                    onClick={() => { setUi((u) => ({ ...u, folderMenu: null })); void actions.launch(tool, folder.id, profile); }}
                  >
                    {toolName(tool)} · {profile}
                  </MenuItem>
                ));
              }
              return (
                <div key={tool}>
                  {tool === "terminal" && <MenuDivider />}
                  <MenuItem
                    icon={<Badge tool={tool} />}
                    onClick={() => { setUi((u) => ({ ...u, folderMenu: null })); void actions.launch(tool, folder.id); }}
                  >
                    {tool === "terminal" ? "Generic terminal" : toolName(tool)}
                  </MenuItem>
                </div>
              );
            })}
          </Menu>
        )}
      </div>

      {expanded && (
        <div id={`folder-sessions-${folder.id}`} className="folder__sessions">
          {folder.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeId}
              ui={ui}
              setUi={setUi}
              onSetCodexProfile={onSetCodexProfile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow(props: {
  session: Session;
  active: boolean;
  ui: Ui;
  setUi: SetUi;
  onSetCodexProfile: (sessionId: string) => void;
}) {
  const { session, active, ui, setUi, onSetCodexProfile } = props;
  const { state, actions } = useAnchor();
  const [hover, setHover] = useState(false);
  const [renameDraft, setRenameDraft] = useState(session.title);
  const renameRef = useRef<HTMLInputElement>(null);

  const menuOpen = ui.sessionMenu === session.id;
  const renaming = ui.sessionRename === session.id;
  const confirming = ui.confirmDelete === session.id;
  const showActions = (hover || menuOpen || confirming) && !renaming;
  const showDot = !hover && !menuOpen && !renaming && !confirming;
  const displayTitle = sessionDisplayTitle(session, state.sessions);

  useEffect(() => {
    if (renaming) {
      setRenameDraft(session.title);
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming, session.title]);

  const commitRename = () => {
    const title = renameDraft.trim() || "untitled";
    if (title !== session.title) void actions.renameSession(session.id, title);
    setUi((u) => ({ ...u, sessionRename: null }));
  };

  return (
    <SidebarRow
      active={active}
      onClick={() => actions.selectSession(session.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setUi((u) => ({
          ...u,
          folderMenu: null,
          folderMore: null,
          sessionMenu: session.id,
          confirmDelete: null,
        }));
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Badge tool={session.tool} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {renaming ? (
          <TextInput
            ref={renameRef}
            variant="inline"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") { e.stopPropagation(); setUi((u) => ({ ...u, sessionRename: null })); }
            }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="a-row__title">{displayTitle}</div>
        )}
      </div>

      <div className="a-row__trail" onClick={(e) => showActions && e.stopPropagation()}>
        {showActions ? (
          <>
            <IconButton danger aria-label="Delete session" onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, confirmDelete: u.confirmDelete === session.id ? null : session.id, sessionMenu: null })); }}>✕</IconButton>
            <IconButton aria-label="More options" style={{ fontSize: 17 }} onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, sessionMenu: u.sessionMenu === session.id ? null : session.id, confirmDelete: null })); }}>⋯</IconButton>
          </>
        ) : (
          showDot && <StatusDot status={session.status} />
        )}
      </div>

      {confirming && (
        <div className="a-confirm" style={{ top: 33, right: 6 }} onClick={(e) => e.stopPropagation()}>
          <div className="a-confirm__title">Delete this session?</div>
          <div className="a-confirm__body">Its saved session ID will be removed.</div>
          <div className="a-confirm__row">
            <Button variant="subtle" block style={{ padding: "6px 0" }} onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, confirmDelete: null })); }}>Cancel</Button>
            <Button variant="danger" block style={{ padding: "6px 0", fontWeight: 600 }} onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, confirmDelete: null })); void actions.deleteSession(session.id); }}>Delete</Button>
          </div>
        </div>
      )}

      {menuOpen && (
        <Menu width={194} style={{ top: 33, right: 6 }}>
          <MenuItem icon="✎" onClick={() => setUi((u) => ({ ...u, sessionRename: session.id, sessionMenu: null }))}>Rename session</MenuItem>
          <MenuItem icon="⧉" onClick={() => { if (session.cliSessionId) actions.copy(session.cliSessionId, "Session ID copied"); setUi((u) => ({ ...u, sessionMenu: null })); }}>Copy session ID</MenuItem>
          {session.tool === "codex" && session.status === "stopped" && (
            state.codexProfiles.length > 1
            || Boolean(session.codexProfile && !state.codexProfiles.includes(session.codexProfile))
          ) && (
            <MenuItem icon="⚙" onClick={() => { setUi((u) => ({ ...u, sessionMenu: null })); onSetCodexProfile(session.id); }}>Set Codex profile</MenuItem>
          )}
        </Menu>
      )}
    </SidebarRow>
  );
}
