/**
 * Left sidebar: filter, folder groups (collapse, rename, quick-launch, remove),
 * session rows (select, close tab, rename, delete, copy id), and the status legend footer.
 * Ephemeral popover/hover/rename state is local; domain mutations go to the store.
 * Built to docs/Anchor.dc.html.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  AttentionDot,
  Badge,
  ConfirmPopover,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  MenuLabel,
  SidebarRow,
  TextInput,
} from "../components/lib";
import type { Folder, Session } from "../ipc/types";
import { useAnchor } from "../app/store";
import {
  EMPTY_FOLDER_HIDE_AFTER_MS,
  favoriteSessions,
  foldersWithSessions,
  moveFolderId,
  orderFolders,
  responseIndicator,
  sessionDisplayTitle,
  splitHiddenFolders,
} from "../app/selectors";
import { LAUNCHABLE, toolName } from "../app/display";
import { activeWorkspace, sessionsForWorkspace } from "../app/workspaces";
import { SESSION_DRAG_TYPE } from "./WorkspaceRail";
import { Icon } from "../components/Icon";

interface SidebarProps {
  onRemoveFolder: (folder: Folder) => void;
  onSetCodexProfile: (sessionId: string) => void;
  onSetSessionId: (sessionId: string) => void;
}

export function Sidebar({ onRemoveFolder, onSetCodexProfile, onSetSessionId }: SidebarProps) {
  const { state, actions } = useAnchor();
  const workspace = activeWorkspace(state.settings);
  const workspaceSessions = useMemo(
    () => sessionsForWorkspace(state.sessions, state.settings, workspace.id),
    [state.sessions, state.settings, workspace.id],
  );
  const orderedFolders = useMemo(
    () => orderFolders(state.folders, workspace.folderOrder),
    [state.folders, workspace.folderOrder],
  );
  const groups = useMemo(
    () => foldersWithSessions(orderedFolders, workspaceSessions, state.filter, state.submittedOrder),
    [orderedFolders, workspaceSessions, state.filter, state.submittedOrder],
  );
  const favorites = useMemo(
    () => favoriteSessions(
      workspaceSessions,
      state.folders,
      workspace.favoriteSessionIds,
      state.filter,
    ),
    [workspaceSessions, state.folders, workspace.favoriteSessionIds, state.filter],
  );
  const folderNames = useMemo(
    () => new Map(state.folders.map((folder) => [folder.id, folder.name])),
    [state.folders],
  );
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [folderClockMs, setFolderClockMs] = useState(() => Date.now());
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
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

  useEffect(() => {
    // A folder must move at the 12-hour boundary even if this app remains open
    // and no registry or settings event causes another render.
    const nextExpiry = groups.reduce((next, folder) => {
      if (folder.sessions.length > 0) return next;
      const emptySince = state.settings.emptyFolderSinceMs[folder.id];
      const expiry = Number.isFinite(emptySince)
        ? emptySince + EMPTY_FOLDER_HIDE_AFTER_MS
        : Number.POSITIVE_INFINITY;
      return expiry > folderClockMs ? Math.min(next, expiry) : next;
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setFolderClockMs(Date.now()),
      Math.max(0, Math.min(nextExpiry - Date.now(), 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [folderClockMs, groups, state.settings.emptyFolderSinceMs]);

  const folderVisibility = useMemo(
    () => splitHiddenFolders(groups, state.settings.emptyFolderSinceMs, folderClockMs),
    [folderClockMs, groups, state.settings.emptyFolderSinceMs],
  );

  const finishFolderDrop = (targetId: string, after: boolean) => {
    if (!draggedFolderId) return;
    const current = orderedFolders.map((folder) => folder.id);
    const next = moveFolderId(current, draggedFolderId, targetId, after);
    setDraggedFolderId(null);
    setDropTarget(null);
    if (next !== current) void actions.reorderFolders(next);
  };

  const renderFolder = (folder: (typeof groups)[number], hidden: boolean) => (
    <FolderGroup
      key={folder.id}
      folder={folder}
      activeId={state.activeId}
      collapsed={workspace.collapsedFolderIds.includes(folder.id)}
      hidden={hidden}
      ui={ui}
      setUi={setUi}
      onToggle={() => void actions.toggleFolderCollapsed(folder.id)}
      onRemoveFolder={onRemoveFolder}
      onSetCodexProfile={onSetCodexProfile}
      onSetSessionId={onSetSessionId}
      dragEnabled={!state.filter.trim()}
      dragging={draggedFolderId === folder.id}
      dropPosition={dropTarget?.id === folder.id ? (dropTarget.after ? "after" : "before") : null}
      onDragStart={(event) => {
        setDraggedFolderId(folder.id);
        setDropTarget(null);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", folder.id);
      }}
      onDragOver={(event) => {
        if (!draggedFolderId || draggedFolderId === folder.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        setDropTarget({ id: folder.id, after: event.clientY >= bounds.top + bounds.height / 2 });
      }}
      onDrop={(event) => {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        finishFolderDrop(folder.id, event.clientY >= bounds.top + bounds.height / 2);
      }}
      onDragEnd={() => {
        setDraggedFolderId(null);
        setDropTarget(null);
      }}
    />
  );

  return (
    <aside className="sidebar">
      <button
        className="current-workspace"
        aria-expanded={state.workspacePaneOpen}
        onClick={() => actions.toggleWorkspacePane()}
      >
        <Icon name="folder" size={15} className="current-workspace__icon" />
        <span className="current-workspace__copy">
          <small>WORKSPACE · SWITCH</small>
          <strong>{workspace.name}</strong>
        </span>
        <Icon name="chevron-right" size={14} className="current-workspace__chevron" />
      </button>
      <div className="sidebar__filter">
        <div className="filter-box">
          <Icon name="search" size={14} className="filter-box__glyph" />
          <TextInput
            id="anchor-filter"
            variant="seamless"
            value={state.filter}
            onChange={(e) => actions.setFilter(e.target.value)}
            placeholder="Search sessions"
            style={{ fontSize: 12.5 }}
          />
          <button className="kbd-chip" onClick={(e) => { e.stopPropagation(); actions.openPalette(); }}>
            ⌘K
          </button>
        </div>
      </div>

      <div className="sidebar__list">
        <SidebarSectionHeader title="Favorites" />
        <div className="sidebar__favorites">
          {favorites.map((session) => (
            <SessionRow
              key={`favorite:${session.id}`}
              instanceKey={`favorite:${session.id}`}
              session={session}
              folderLabel={folderNames.get(session.folderId)}
              active={session.id === state.activeId}
              ui={ui}
              setUi={setUi}
              onSetCodexProfile={onSetCodexProfile}
              onSetSessionId={onSetSessionId}
            />
          ))}
          {favorites.length === 0 && (
            <div className="sidebar-section__empty">
              {state.filter.trim() ? "No favorite chats match." : "Favorite chats appear here."}
            </div>
          )}
        </div>

        <SidebarSectionHeader title="All chats" />
        {folderVisibility.visible.map((folder) => renderFolder(folder, false))}

        {folderVisibility.hidden.length > 0 && (
          <div className="sidebar-hidden">
            <button
              className="sidebar-hidden__toggle"
              aria-expanded={hiddenExpanded}
              onClick={() => setHiddenExpanded((expanded) => !expanded)}
            >
              <Icon name={hiddenExpanded ? "chevron-down" : "chevron-right"} size={13} className="sidebar-hidden__chevron" />
              <span>Hidden</span>
              <span className="sidebar-hidden__count">{folderVisibility.hidden.length}</span>
              <span className="sidebar-section__line" aria-hidden="true" />
            </button>
            {hiddenExpanded && (
              <div className="sidebar-hidden__groups">
                {folderVisibility.hidden.map((folder) => renderFolder(folder, true))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar__footer">
        <button className="sidebar__rail-toggle" onClick={() => actions.toggleWorkspacePane()} aria-label="Toggle workspaces"><Icon name="panel" size={15} /></button>
        <button className="sidebar__settings" onClick={() => actions.openSettings()}><Icon name="settings" size={14} />Settings</button>
      </div>
    </aside>
  );
}

function SidebarSectionHeader({ title }: { title: string }) {
  return (
    <div className="sidebar-section" role="heading" aria-level={2}>
      <span>{title}</span>
      <span className="sidebar-section__line" aria-hidden="true" />
    </div>
  );
}

interface Ui {
  folderMenu: string | null;
  folderMore: string | null;
  folderRename: string | null;
  /** Instance keys keep duplicate Favorite and All chats rows independent. */
  sessionMenu: string | null;
  sessionRename: string | null;
  confirmDelete: string | null;
}

type SetUi = React.Dispatch<React.SetStateAction<Ui>>;

function FolderGroup(props: {
  folder: Folder & { sessions: Session[] };
  activeId: string | null;
  collapsed: boolean;
  hidden: boolean;
  ui: Ui;
  setUi: SetUi;
  onToggle: () => void;
  onRemoveFolder: (folder: Folder) => void;
  onSetCodexProfile: (sessionId: string) => void;
  onSetSessionId: (sessionId: string) => void;
  dragEnabled: boolean;
  dragging: boolean;
  dropPosition: "before" | "after" | null;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const {
    folder, activeId, collapsed, hidden, ui, setUi, onToggle, onRemoveFolder,
    onSetCodexProfile, onSetSessionId, dragEnabled, dragging, dropPosition,
    onDragStart, onDragOver, onDrop, onDragEnd,
  } = props;
  const { state, actions } = useAnchor();
  const [hover, setHover] = useState(false);
  const [renameDraft, setRenameDraft] = useState(folder.name);
  const renameRef = useRef<HTMLInputElement>(null);
  const moreAnchorRef = useRef<HTMLButtonElement>(null);
  const launchAnchorRef = useRef<HTMLButtonElement>(null);

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
    <div
      className={`folder${hidden ? " folder--hidden" : ""}`}
      data-dragging={dragging || undefined}
      data-drop={dropPosition ?? undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className="folder__head"
        draggable={dragEnabled && !renaming}
        title={dragEnabled ? "Drag project group to reorder" : undefined}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
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
            <span className="folder__disclosure" aria-hidden="true"><Icon name={expanded ? "chevron-down" : "chevron-right"} size={13} /></span>
            <span className="folder__label">{folder.name}</span>
          </button>
        )}
        {/* Both stay laid out (hidden, not unmounted) so revealing them on
            hover never reflows the header's name or count. */}
        <IconButton
          ref={moreAnchorRef}
          aria-label="Folder options"
          size={20}
          tabIndex={showMore ? 0 : -1}
          style={{ fontSize: 15, visibility: showMore ? "visible" : "hidden" }}
          onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, folderMore: u.folderMore === folder.id ? null : folder.id, folderMenu: null, sessionMenu: null })); }}
        >
          <Icon name="more" size={15} />
        </IconButton>
        <IconButton
          ref={launchAnchorRef}
          bordered
          aria-label="Quick launch"
          size={20}
          tabIndex={showAdd ? 0 : -1}
          style={{ fontSize: 14, visibility: showAdd ? "visible" : "hidden" }}
          onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, folderMenu: u.folderMenu === folder.id ? null : folder.id, folderMore: null, sessionMenu: null })); }}
        >
          <Icon name="plus" size={14} />
        </IconButton>

        {ui.folderMore === folder.id && (
          <Menu anchorRef={moreAnchorRef} width={206}>
            <MenuItem icon={<Icon name="edit" size={14} />} onClick={() => setUi((u) => ({ ...u, folderRename: folder.id, folderMore: null }))}>Rename group</MenuItem>
            <MenuItem icon={<Icon name="copy" size={14} />} onClick={() => { actions.copy(folder.path, "Folder path copied"); setUi((u) => ({ ...u, folderMore: null })); }}>Copy folder path</MenuItem>
            <MenuDivider />
            <MenuItem danger icon={<Icon name="trash" size={14} />} onClick={() => { setUi((u) => ({ ...u, folderMore: null })); onRemoveFolder(folder); }}>Remove group</MenuItem>
          </Menu>
        )}

        {ui.folderMenu === folder.id && (
          <Menu anchorRef={launchAnchorRef} width={236}>
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
            {state.settings.customHarnesses.some((harness) => harness.enabled) && (
              <>
                <MenuDivider />
                <MenuLabel>Custom harnesses</MenuLabel>
                {state.settings.customHarnesses.filter((harness) => harness.enabled).map((harness) => (
                  <MenuItem
                    key={harness.id}
                    icon={<Icon name="wrench" size={14} />}
                    onClick={() => {
                      setUi((u) => ({ ...u, folderMenu: null }));
                      void actions.launchCustomHarness(harness.id, folder.id);
                    }}
                  >
                    {harness.name}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
        )}
      </div>

      {expanded && (
        <div id={`folder-sessions-${folder.id}`} className="folder__sessions">
          {folder.sessions.map((session) => (
            <SessionRow
              key={session.id}
              instanceKey={`all:${session.id}`}
              session={session}
              active={session.id === activeId}
              ui={ui}
              setUi={setUi}
              onSetCodexProfile={onSetCodexProfile}
              onSetSessionId={onSetSessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow(props: {
  instanceKey: string;
  session: Session;
  folderLabel?: string;
  active: boolean;
  ui: Ui;
  setUi: SetUi;
  onSetCodexProfile: (sessionId: string) => void;
  onSetSessionId: (sessionId: string) => void;
}) {
  const { instanceKey, session, folderLabel, active, ui, setUi, onSetCodexProfile, onSetSessionId } = props;
  const { state, actions } = useAnchor();
  const [hover, setHover] = useState(false);
  const [renameDraft, setRenameDraft] = useState(session.title);
  const renameRef = useRef<HTMLInputElement>(null);
  const deleteAnchorRef = useRef<HTMLButtonElement>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const menuOpen = ui.sessionMenu === instanceKey;
  const renaming = ui.sessionRename === instanceKey;
  const confirming = ui.confirmDelete === instanceKey;
  const showActions = (hover || menuOpen || confirming) && !renaming;
  const showIndicator = !hover && !menuOpen && !renaming && !confirming;
  const indicator = responseIndicator(session.id, state.openTabs, state.unreadResponses);
  const openInTab = state.openTabs.includes(session.id);
  const favorite = activeWorkspace(state.settings).favoriteSessionIds.includes(session.id);
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
      data-session-id={session.id}
      active={active}
      draggable={!renaming}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
      }}
      onClick={() => actions.selectSession(session.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setUi((u) => ({
          ...u,
          folderMenu: null,
          folderMore: null,
          sessionMenu: instanceKey,
          confirmDelete: null,
        }));
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
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
          <>
            <div className="a-row__title">{displayTitle}</div>
            {folderLabel && <div className="a-row__meta">{folderLabel}</div>}
          </>
        )}
      </div>

      <div className="a-row__trail" onClick={(e) => showActions && e.stopPropagation()}>
        {showActions ? (
          <>
            {openInTab ? (
              <IconButton
                ref={deleteAnchorRef}
                aria-label="Close tab from sidebar"
                title="Close tab"
                style={{ fontSize: 14 }}
                onClick={(e) => { e.stopPropagation(); void actions.closeTabImmediately(session.id); }}
              >
                <Icon name="chevron-down" size={14} />
              </IconButton>
            ) : (
              <IconButton ref={deleteAnchorRef} danger aria-label="Delete session" onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, confirmDelete: u.confirmDelete === instanceKey ? null : instanceKey, sessionMenu: null })); }}><Icon name="trash" size={13} /></IconButton>
            )}
            <IconButton ref={menuAnchorRef} aria-label="More options" onClick={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, sessionMenu: u.sessionMenu === instanceKey ? null : instanceKey, confirmDelete: null })); }}><Icon name="more" size={15} /></IconButton>
          </>
        ) : (
          showIndicator && indicator && <AttentionDot ready={indicator === "ready"} />
        )}
      </div>

      {confirming && (
        <ConfirmPopover
          anchorRef={deleteAnchorRef}
          title="Delete this session?"
          body="Its saved session ID will be removed."
          onCancel={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, confirmDelete: null })); }}
          onConfirm={(e) => { e.stopPropagation(); setUi((u) => ({ ...u, confirmDelete: null })); void actions.deleteSession(session.id); }}
        />
      )}

      {menuOpen && (
        <Menu anchorRef={menuAnchorRef} width={220}>
          <MenuItem icon={<Icon name="edit" size={14} />} onClick={() => setUi((u) => ({ ...u, sessionRename: instanceKey, sessionMenu: null }))}>Rename session</MenuItem>
          <MenuItem icon={<Icon name="star" size={14} style={favorite ? { fill: "currentColor" } : undefined} />} onClick={() => { setUi((u) => ({ ...u, sessionMenu: null })); void actions.toggleFavoriteSession(session.id); }}>
            {favorite ? "Remove from favorites" : "Add to favorites"}
          </MenuItem>
          <MenuDivider />
          <MenuItem icon={<Icon name="copy" size={14} />} onClick={() => { if (session.cliSessionId) actions.copy(session.cliSessionId, "Session ID copied"); setUi((u) => ({ ...u, sessionMenu: null })); }}>Copy session ID</MenuItem>
          {(session.tool !== "terminal" || Boolean(state.settings.sessionHarnessIds[session.id])) && session.status === "stopped" && (
            <MenuItem icon={<Icon name="wrench" size={14} />} onClick={() => { setUi((u) => ({ ...u, sessionMenu: null })); onSetSessionId(session.id); }}>Set session ID</MenuItem>
          )}
          {session.tool === "codex" && session.status === "stopped" && (
            state.codexProfiles.length > 1
            || Boolean(session.codexProfile && !state.codexProfiles.includes(session.codexProfile))
          ) && (
            <MenuItem icon={<Icon name="settings" size={14} />} onClick={() => { setUi((u) => ({ ...u, sessionMenu: null })); onSetCodexProfile(session.id); }}>Set Codex profile</MenuItem>
          )}
        </Menu>
      )}
    </SidebarRow>
  );
}
