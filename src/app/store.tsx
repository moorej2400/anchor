/**
 * Anchor application store — the single owner of domain + navigation state,
 * wired to the Rust core through the typed IPC layer (src/ipc). Ephemeral UI
 * state (open menus, hover, inline-rename drafts) lives in the components; this
 * store holds what multiple views share: folders, sessions, settings, tabs,
 * the active session, the current view, filter, palette, and toast.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { ipc } from "../ipc/commands";
import {
  onAttentionCount,
  onPtyOutput,
  onSessionResumeError,
  onSessionStatus,
  onSessionUpdated,
} from "../ipc/events";
import type { CliInfo, Folder, PtyReplay, Session, Settings, Tool } from "../ipc/types";
import { isOn } from "./selectors";
import { applyTheme } from "./theme";
import { TerminalManager } from "./terminals";

export type SettingsSection = "general" | "persistence" | "appearance" | "shortcuts";
export type View = "terminal" | "settings";

export interface OperationError {
  operation: "launch" | "resume";
  tool: Tool;
  message: string;
  code: string | null;
  /** A CLI-not-found failure has a concrete recovery path the UI can show. */
  isCliNotFound: boolean;
}

export interface LaunchError extends OperationError {
  operation: "launch";
  folderId: string;
}

interface State {
  loaded: boolean;
  bootReady: boolean;
  folders: Folder[];
  sessions: Session[];
  settings: Settings;
  clis: CliInfo[];
  /** Available Codex profile names; a failed lookup leaves this empty. */
  codexProfiles: string[];
  openTabs: string[];
  activeId: string | null;
  /** Sidebar ordering: session id → sequence of the last keystroke sent to it. */
  typedOrder: Record<string, number>;
  /** Monotonic counter backing `typedOrder`. */
  typeSeq: number;
  view: View;
  settingsSection: SettingsSection;
  filter: string;
  paletteOpen: boolean;
  newSessionOpen: boolean;
  /** When set, the wizard skips the folder step and launches into this folder. */
  newSessionFolderId: string | null;
  /** Tab awaiting close confirmation, when `confirmClose` guards a live session. */
  closeConfirmId: string | null;
  /** The latest failed launch stays visible until the user retries or dismisses it. */
  launchError: LaunchError | null;
  /** Resume failures belong to their stopped session so switching tabs does not hide them. */
  resumeErrors: Record<string, OperationError>;
  toast: string | null;
  waitingCount: number;
  fatalError: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  shell: "/bin/zsh",
  envVars: [],
  autoRestore: true,
  confirmClose: true,
  stopOnClose: true,
  restoreScrollback: true,
  backupPath: "~/.anchor/sessions",
  projectsDir: "~/Documents/Anchor/Projects",
  retentionDays: 30,
  theme: "graphite",
  density: "comfortable",
  fontSize: 13,
  accent: "#d6417a",
  notifyOnWaiting: false,
};

const initialState: State = {
  loaded: false,
  bootReady: false,
  folders: [],
  sessions: [],
  settings: DEFAULT_SETTINGS,
  clis: [],
  codexProfiles: [],
  openTabs: [],
  activeId: null,
  typedOrder: {},
  typeSeq: 0,
  view: "terminal",
  settingsSection: "general",
  filter: "",
  paletteOpen: false,
  newSessionOpen: false,
  newSessionFolderId: null,
  closeConfirmId: null,
  launchError: null,
  resumeErrors: {},
  toast: null,
  waitingCount: 0,
  fatalError: null,
};

type Action =
  | { type: "HYDRATE"; folders: Folder[]; sessions: Session[]; settings: Settings; clis: CliInfo[]; codexProfiles: string[]; openTabs: string[]; activeId: string | null }
  | { type: "RECONCILE_SESSIONS"; sessions: Session[] }
  | { type: "UPSERT_SESSION"; session: Session }
  | { type: "REMOVE_SESSION"; id: string }
  | { type: "SET_STATUS"; id: string; status: Session["status"] }
  | { type: "UPSERT_FOLDER"; folder: Folder }
  | { type: "REMOVE_FOLDER"; id: string }
  | { type: "OPEN_TAB"; id: string }
  | { type: "CLOSE_TAB"; id: string }
  | { type: "RESTORE_TAB"; id: string }
  | { type: "SET_ACTIVE"; id: string | null }
  | { type: "SESSION_TYPED"; id: string }
  | { type: "SET_VIEW"; view: View }
  | { type: "SET_SETTINGS_SECTION"; section: SettingsSection }
  | { type: "SET_FILTER"; value: string }
  | { type: "SET_PALETTE"; open: boolean }
  | { type: "SET_NEW_SESSION"; open: boolean; folderId?: string | null }
  | { type: "SET_CLOSE_CONFIRM"; id: string | null }
  | { type: "SET_LAUNCH_ERROR"; error: LaunchError | null }
  | { type: "SET_RESUME_ERROR"; id: string; error: OperationError | null }
  | { type: "SET_TOAST"; text: string | null }
  | { type: "SET_SETTINGS"; settings: Settings }
  | { type: "SET_WAITING"; count: number }
  | { type: "BOOT_READY" }
  | { type: "FATAL"; message: string };

type BootSessionAction =
  | { type: "UPSERT_SESSION"; session: Session }
  | { type: "SET_STATUS"; id: string; status: Session["status"] };

function applyBootSessionAction(sessions: Session[], action: BootSessionAction): Session[] {
  if (action.type === "UPSERT_SESSION") {
    const exists = sessions.some((session) => session.id === action.session.id);
    return exists
      ? sessions.map((session) => session.id === action.session.id ? action.session : session)
      : [...sessions, action.session];
  }
  return sessions.map((session) =>
    session.id === action.id ? { ...session, status: action.status } : session,
  );
}

/** Drop deleted sessions from the typed-order map so it can't grow unbounded. */
function withoutIds(
  typedOrder: Record<string, number>,
  ids: string[],
): Record<string, number> {
  if (!ids.some((id) => id in typedOrder)) return typedOrder;
  const next = { ...typedOrder };
  for (const id of ids) delete next[id];
  return next;
}

function pickAdjacent(openTabs: string[], closingId: string): string | null {
  const i = openTabs.indexOf(closingId);
  const remaining = openTabs.filter((t) => t !== closingId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(i, remaining.length - 1)] ?? null;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "HYDRATE":
      return {
        ...state,
        loaded: true,
        folders: action.folders,
        sessions: action.sessions,
        settings: action.settings,
        clis: action.clis,
        codexProfiles: action.codexProfiles,
        openTabs: action.openTabs,
        activeId: action.activeId,
      };
    case "RECONCILE_SESSIONS": {
      const ids = new Set(action.sessions.map((session) => session.id));
      const removedIds = state.sessions
        .filter((session) => !ids.has(session.id))
        .map((session) => session.id);
      const openTabs = state.openTabs.filter((id) => ids.has(id));
      const activeId = state.activeId && ids.has(state.activeId)
        ? state.activeId
        : openTabs[openTabs.length - 1] ?? null;
      const resumeErrors = Object.fromEntries(
        Object.entries(state.resumeErrors).filter(([id]) => ids.has(id)),
      );
      return {
        ...state,
        sessions: action.sessions,
        openTabs,
        activeId,
        typedOrder: withoutIds(state.typedOrder, removedIds),
        resumeErrors,
        closeConfirmId: state.closeConfirmId && ids.has(state.closeConfirmId)
          ? state.closeConfirmId
          : null,
      };
    }
    case "UPSERT_SESSION": {
      const exists = state.sessions.some((s) => s.id === action.session.id);
      return {
        ...state,
        sessions: exists
          ? state.sessions.map((s) => (s.id === action.session.id ? action.session : s))
          : [...state.sessions, action.session],
      };
    }
    case "REMOVE_SESSION": {
      const active =
        state.activeId === action.id ? pickAdjacent(state.openTabs, action.id) : state.activeId;
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.id !== action.id),
        openTabs: state.openTabs.filter((t) => t !== action.id),
        activeId: active,
        typedOrder: withoutIds(state.typedOrder, [action.id]),
        closeConfirmId: state.closeConfirmId === action.id ? null : state.closeConfirmId,
      };
    }
    case "SET_STATUS":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, status: action.status } : s,
        ),
      };
    case "UPSERT_FOLDER": {
      const exists = state.folders.some((f) => f.id === action.folder.id);
      return {
        ...state,
        folders: exists
          ? state.folders.map((f) => (f.id === action.folder.id ? action.folder : f))
          : [...state.folders, action.folder],
      };
    }
    case "REMOVE_FOLDER": {
      const ids = new Set(state.sessions.filter((s) => s.folderId === action.id).map((s) => s.id));
      const openTabs = state.openTabs.filter((t) => !ids.has(t));
      const active =
        state.activeId && ids.has(state.activeId)
          ? openTabs[openTabs.length - 1] ?? null
          : state.activeId;
      return {
        ...state,
        folders: state.folders.filter((f) => f.id !== action.id),
        sessions: state.sessions.filter((s) => s.folderId !== action.id),
        openTabs,
        activeId: active,
        typedOrder: withoutIds(state.typedOrder, [...ids]),
      };
    }
    case "OPEN_TAB": {
      const openTabs = state.openTabs.includes(action.id)
        ? state.openTabs
        : [...state.openTabs, action.id];
      // A launch error is a transient pane overlay. Selecting any real session
      // must restore that session's terminal or Resume card instead of leaving
      // an unrelated failed launch on top of it.
      return { ...state, openTabs, activeId: action.id, view: "terminal", paletteOpen: false, launchError: null };
    }
    case "CLOSE_TAB": {
      const active =
        state.activeId === action.id ? pickAdjacent(state.openTabs, action.id) : state.activeId;
      return {
        ...state,
        openTabs: state.openTabs.filter((t) => t !== action.id),
        activeId: active,
        // The tab this prompt belonged to is gone; never leave it orphaned on
        // a tab index some other session now occupies.
        closeConfirmId: state.closeConfirmId === action.id ? null : state.closeConfirmId,
      };
    }
    case "RESTORE_TAB": {
      // Undo of an optimistic close: the tab comes back, but the selection the
      // user has since made is theirs to keep.
      const openTabs = state.openTabs.includes(action.id)
        ? state.openTabs
        : [...state.openTabs, action.id];
      return { ...state, openTabs, activeId: state.activeId ?? action.id };
    }
    case "SET_ACTIVE":
      return { ...state, activeId: action.id, view: "terminal", launchError: null };
    case "SESSION_TYPED": {
      // Fires on every keystroke. Once a session already holds the newest
      // sequence it is at the top of its folder and cannot move further, so
      // return the same state and let React bail out of the re-render.
      if (state.typedOrder[action.id] === state.typeSeq) return state;
      const typeSeq = state.typeSeq + 1;
      return { ...state, typeSeq, typedOrder: { ...state.typedOrder, [action.id]: typeSeq } };
    }
    case "SET_VIEW":
      return { ...state, view: action.view };
    case "SET_SETTINGS_SECTION":
      return { ...state, settingsSection: action.section };
    case "SET_FILTER":
      return { ...state, filter: action.value };
    case "SET_PALETTE":
      return { ...state, paletteOpen: action.open };
    case "SET_NEW_SESSION":
      return {
        ...state,
        newSessionOpen: action.open,
        newSessionFolderId: action.open ? action.folderId ?? null : null,
      };
    case "SET_CLOSE_CONFIRM":
      return state.closeConfirmId === action.id ? state : { ...state, closeConfirmId: action.id };
    case "SET_LAUNCH_ERROR":
      return { ...state, launchError: action.error };
    case "SET_RESUME_ERROR": {
      const resumeErrors = { ...state.resumeErrors };
      if (action.error) resumeErrors[action.id] = action.error;
      else delete resumeErrors[action.id];
      return { ...state, resumeErrors };
    }
    case "SET_TOAST":
      return { ...state, toast: action.text };
    case "SET_SETTINGS":
      return { ...state, settings: action.settings };
    case "SET_WAITING":
      return { ...state, waitingCount: action.count };
    case "BOOT_READY":
      return { ...state, bootReady: true };
    case "FATAL":
      return { ...state, fatalError: action.message };
    default:
      return state;
  }
}

interface AnchorContextValue {
  state: State;
  terminals: TerminalManager;
  actions: Actions;
}

const AnchorContext = createContext<AnchorContextValue | null>(null);

export function AnchorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const deletedSessionIds = useRef(new Set<string>());

  // Toast auto-dismiss.
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useRef((text: string) => {
    dispatch({ type: "SET_TOAST", text });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => dispatch({ type: "SET_TOAST", text: null }), 1600);
  }).current;

  const terminals = useMemo(
    () => {
      // This callback is xterm's onData — real user keystrokes only, never PTY
      // output — so it is the right signal for activity-based sidebar order.
      const manager = new TerminalManager((sessionId, data) => {
        dispatch({ type: "SESSION_TYPED", id: sessionId });
        void ipc.writePty(sessionId, data).catch(() => {});
      },
      (sessionId, size) => ipc.resizePty(sessionId, size.cols, size.rows),
      (_sessionId, error) => showToast(`Terminal resize failed: ${shortError(error)}`));
      manager.beginReplayCapture();
      return manager;
    },
    [showToast],
  );

  // Boot: subscribe to events, load state/settings/clis, restore tabs, then
  // tell the backend the frontend is ready. Listeners come first so PTY output
  // and status emitted by auto-restore cannot be lost (SPEC.md §8), and
  // `frontend_ready` comes after hydration and terminal viewport measurement.
  useEffect(() => {
    let unlisten: Array<() => void> = [];
    let cancelled = false;
    let hydrated = false;
    let bootSessions: Session[] = [];
    let authoritativeIds: Set<string> | null = null;
    let bootTracking = true;
    const bootSessionActions: BootSessionAction[] = [];
    const deliverSessionAction = (action: BootSessionAction) => {
      const id = action.type === "UPSERT_SESSION" ? action.session.id : action.id;
      if (authoritativeIds && !stateRef.current.bootReady && !authoritativeIds.has(id)) {
        // Launch is blocked until boot completes. An unknown ID after the final
        // registry read is therefore a delayed event for a deleted session.
        deletedSessionIds.current.add(id);
        terminals.ignoreOutput(id);
        return;
      }
      if (bootTracking) bootSessionActions.push(action);
      if (hydrated && bootTracking) {
        bootSessions = applyBootSessionAction(bootSessions, action);
        dispatch(action);
      } else if (!bootTracking) {
        dispatch(action);
      }
    };

    (async () => {
      try {
        const subs = await Promise.all([
          onPtyOutput((p) =>
            terminals.write(p.sessionId, p.data, p.sequence, p.gridEpoch, p.cols, p.rows)
          ),
          onSessionStatus((p) => {
            if (deletedSessionIds.current.has(p.sessionId)) return;
            if (p.status === "running") terminals.commitSessionPreparation(p.sessionId);
            deliverSessionAction({ type: "SET_STATUS", id: p.sessionId, status: p.status });
          }),
          onSessionUpdated((s) => {
            if (!deletedSessionIds.current.has(s.id)) {
              deliverSessionAction({ type: "UPSERT_SESSION", session: s });
            }
          }),
          onSessionResumeError((p) => {
            if (deletedSessionIds.current.has(p.sessionId)) return;
            dispatch({
              type: "SET_RESUME_ERROR",
              id: p.sessionId,
              error: {
                operation: "resume",
                tool: "codex",
                code: p.code,
                message: p.message,
                isCliNotFound: false,
              },
            });
            showToast(p.message);
          }),
          onAttentionCount((p) => dispatch({ type: "SET_WAITING", count: p.waiting })),
        ]);
        if (cancelled) {
          subs.forEach((u) => u());
          return;
        }
        unlisten = subs;

        const [snapshot, settings, clis, codexProfiles] = await Promise.all([
          ipc.getState(),
          ipc.getSettings(),
          ipc.detectClis(),
          // Profile discovery is optional. Codex still works with its base
          // config when a platform cannot enumerate profiles.
          ipc.getCodexProfiles().catch(() => []),
        ]);
        if (cancelled) return;

        applyTheme(settings);
        // The probe can exist before settings load. Update xterm itself, not
        // only the CSS variable, before measuring the grid used for restore.
        terminals.setFontSize(settings.fontSize);

        let hydratedSessions = snapshot.sessions;
        for (const action of bootSessionActions) {
          hydratedSessions = applyBootSessionAction(hydratedSessions, action);
        }
        bootSessions = hydratedSessions;

        const restore = settings.autoRestore;
        const restoredTabs = restore
          ? hydratedSessions.filter((s) => s.wasOpenInTab).map((s) => s.id)
          : [];
        dispatch({
          type: "HYDRATE",
          folders: snapshot.folders,
          sessions: hydratedSessions,
          settings,
          clis,
          codexProfiles,
          openTabs: restoredTabs,
          activeId: restoredTabs[0] ?? null,
        });
        hydrated = true;

        // HYDRATE is queued before any status event auto-restore can produce,
        // so restored `running` sessions are not overwritten by this snapshot.
        // Auto-restore must not let a CLI draw at xterm's 80×24 default. The
        // viewport probe uses the same host and font metrics as every slot.
        const terminalSize = await terminals.waitForViewport();
        if (cancelled) return;

        // Keep all restore output raw until the backend completes its guarded
        // restore pass. Each replay below supplies the live PTY's actual grid,
        // including when this webview arrived just after that pass finished.
        await ipc.frontendReady(terminalSize);
        if (cancelled) return;

        // Command completion and Tauri event delivery use independent queues.
        // Re-read the registry after restore, then fold only events delivered
        // during that read into the authoritative snapshot.
        const actionBoundary = bootSessionActions.length;
        const restoredSnapshot = await ipc.getState();
        if (cancelled) return;
        let reconciledSessions = restoredSnapshot.sessions;
        const restoredIds = new Set(restoredSnapshot.sessions.map((session) => session.id));
        for (const action of bootSessionActions.slice(actionBoundary)) {
          const id = action.type === "UPSERT_SESSION" ? action.session.id : action.id;
          if (restoredIds.has(id)) {
            reconciledSessions = applyBootSessionAction(reconciledSessions, action);
          } else {
            deletedSessionIds.current.add(id);
            terminals.ignoreOutput(id);
          }
        }
        const reconciledIds = new Set(reconciledSessions.map((session) => session.id));
        authoritativeIds = reconciledIds;
        for (const session of bootSessions) {
          if (!reconciledIds.has(session.id)) {
            deletedSessionIds.current.add(session.id);
            terminals.ignoreOutput(session.id);
          }
        }
        bootSessions = reconciledSessions;
        dispatch({ type: "RECONCILE_SESSIONS", sessions: reconciledSessions });

        const liveSessions = bootSessions.filter((session) => isOn(session.status));
        for (const session of bootSessions) {
          if (!isOn(session.status)) terminals.ignoreOutput(session.id);
        }

        // A page reload destroys every xterm buffer while PTYs keep running.
        for (const session of liveSessions) {
          if (terminals.claimReplay(session.id)) {
            try {
              await applyReplayWithRefresh(terminals, session.id);
            } catch (error) {
              terminals.rejectReplay(session.id);
              showToast(`Terminal replay failed: ${shortError(error)}`);
            }
          }
        }
        for (const id of terminals.reconcileCapturedOutput(reconciledIds)) {
          deletedSessionIds.current.add(id);
        }
        terminals.finishReplayCapture();
        for (const session of liveSessions) terminals.fit(session.id);
        if (!cancelled) {
          bootTracking = false;
          bootSessionActions.length = 0;
          bootSessions = [];
          dispatch({ type: "BOOT_READY" });
        }
      } catch (e) {
        if (!cancelled) dispatch({ type: "FATAL", message: String(e) });
      }
    })();

    return () => {
      cancelled = true;
      unlisten.forEach((u) => u());
    };
  }, [terminals]);

  const actions = useMemo(
    () => makeActions(dispatch, stateRef, terminals, deletedSessionIds.current, showToast),
    [terminals, showToast],
  );

  const value = useMemo<AnchorContextValue>(
    () => ({ state, terminals, actions }),
    [state, terminals, actions],
  );

  return <AnchorContext.Provider value={value}>{children}</AnchorContext.Provider>;
}

export function useAnchor(): AnchorContextValue {
  const ctx = useContext(AnchorContext);
  if (!ctx) throw new Error("useAnchor must be used within AnchorProvider");
  return ctx;
}

// --- Action creators (async orchestration: call IPC, then dispatch) ---

export interface Actions {
  selectSession(id: string): void;
  launch(tool: Tool, folderId: string, codexProfile?: string | null): Promise<void>;
  resume(id: string): Promise<void>;
  forkCodex(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  confirmCloseTab(): Promise<void>;
  cancelCloseTab(): void;
  stop(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  setCodexProfile(id: string, codexProfile: string | null): Promise<boolean>;
  addFolder(path: string): Promise<Folder | null>;
  createProject(name: string): Promise<Folder | null>;
  renameFolder(id: string, name: string): Promise<void>;
  removeFolder(id: string): Promise<void>;
  setFilter(value: string): void;
  openPalette(): void;
  closePalette(): void;
  openNewSession(folderId?: string | null): void;
  closeNewSession(): void;
  openSettings(): void;
  closeSettings(): void;
  setSettingsSection(section: SettingsSection): void;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  copy(text: string, label: string): void;
  dismissLaunchError(): void;
  toast(text: string): void;
}

function makeActions(
  dispatch: React.Dispatch<Action>,
  stateRef: React.MutableRefObject<State>,
  terminals: TerminalManager,
  deletedSessionIds: Set<string>,
  showToast: (text: string) => void,
): Actions {
  const tabStateWrites = new Map<string, Promise<void>>();
  const setTabOpenOrdered = (id: string, open: boolean): Promise<void> => {
    const previous = tabStateWrites.get(id);
    const current = previous
      ? previous.catch(() => {}).then(() => ipc.setTabOpen(id, open))
      : ipc.setTabOpen(id, open);
    tabStateWrites.set(id, current);
    void current.then(
      () => {
        if (tabStateWrites.get(id) === current) tabStateWrites.delete(id);
      },
      () => {
        if (tabStateWrites.get(id) === current) tabStateWrites.delete(id);
      },
    );
    return current;
  };
  const persistTabOpen = (id: string, open: boolean) => {
    void setTabOpenOrdered(id, open).catch(() => {});
  };

  // Tabs with a close request still in flight, keyed to the token of the
  // request that owns them. Reopening a tab clears its token, so a close that
  // settles afterwards neither disposes the terminal nor undoes the reopen.
  const closingTabs = new Map<string, symbol>();
  type ResumeOperation = {
    token: symbol;
    spawned: boolean;
    done: Promise<void>;
    resolveDone: () => void;
  };
  const resumingSessions = new Map<string, ResumeOperation>();
  const forkingSessions = new Set<string>();

  // `set_tab_open(false)` is the sole close lifecycle command: with stopOnClose
  // the backend stops the PTY itself, so a second stop_session here would only
  // queue behind work already done (SPEC.md §8). The tab disappears
  // immediately; shutdown finishes in the background.
  async function performClose(id: string): Promise<void> {
    const session = stateRef.current.sessions.find((candidate) => candidate.id === id);
    const stopOnClose = stateRef.current.settings.stopOnClose;
    const resumeOperation = resumingSessions.get(id);
    const closeToken = Symbol(id);
    closingTabs.set(id, closeToken);
    dispatch({ type: "CLOSE_TAB", id });

    try {
      // Resume observes this close token at each preparation boundary. If its
      // IPC is already inside the backend, wait for it and then send the sole
      // close command so stopOnClose observes that new live PTY. Reopening can
      // remove the close token without destroying ownership of that resume.
      if (resumeOperation) await resumeOperation.done;
      if (closingTabs.get(id) !== closeToken) return;
      await setTabOpenOrdered(id, false);
      if (closingTabs.get(id) !== closeToken) return;
      closingTabs.delete(id);
      const resumedLive = resumeOperation?.spawned ?? false;
      if (session && (stopOnClose || (!resumedLive && !isOn(session.status)))) {
        terminals.dispose(id);
      }
    } catch (e) {
      if (closingTabs.get(id) === closeToken) {
        closingTabs.delete(id);
        dispatch({ type: "RESTORE_TAB", id });
      }
      showToast(shortError(e));
    }
  }

  return {
    selectSession(id) {
      closingTabs.delete(id);
      const already = stateRef.current.openTabs.includes(id);
      dispatch({ type: "OPEN_TAB", id });
      if (!already) persistTabOpen(id, true);
    },
    async launch(tool, folderId, codexProfile) {
      if (!stateRef.current.bootReady) {
        showToast("Anchor is still restoring sessions.");
        return;
      }
      dispatch({ type: "SET_LAUNCH_ERROR", error: null });
      // Settings unmounts the measurement surface. Restore the terminal view
      // first so waitForViewport receives a current pane size.
      dispatch({ type: "SET_VIEW", view: "terminal" });
      try {
        const terminalSize = await terminals.waitForViewport();
        const session = codexProfile === undefined
          ? await ipc.launchSession(folderId, tool, terminalSize)
          : await ipc.launchSession(folderId, tool, terminalSize, undefined, undefined, codexProfile);
        dispatch({ type: "SET_LAUNCH_ERROR", error: null });
        dispatch({ type: "UPSERT_SESSION", session });
        dispatch({ type: "OPEN_TAB", id: session.id });
        persistTabOpen(session.id, true);
      } catch (e) {
        const baseError = operationError("launch", tool, e);
        const error: LaunchError = { ...baseError, operation: "launch", folderId };
        dispatch({ type: "SET_LAUNCH_ERROR", error });
        showToast(error.message);
      }
    },
    async resume(id) {
      if (!stateRef.current.bootReady) {
        showToast("Anchor is still restoring sessions.");
        return;
      }
      const previous = stateRef.current.sessions.find((candidate) => candidate.id === id);
      if (!previous) return;
      dispatch({ type: "SET_RESUME_ERROR", id, error: null });
      // AI CLIs can only resume their saved provider ID. Opening a provider
      // picker here would resume an unrelated conversation and violate §1.
      if (previous.tool !== "terminal" && !previous.cliSessionId) {
        const error: OperationError = {
          operation: "resume",
          tool: previous.tool,
          code: "SESSION_ID_UNAVAILABLE",
          message: "This session has no saved CLI session ID.",
          isCliNotFound: false,
        };
        dispatch({ type: "SET_RESUME_ERROR", id, error });
        showToast(error.message);
        return;
      }
      // Keyboard and pointer activation can arrive in the same render frame.
      // One session may own only one resume preparation and IPC call at a time.
      if (resumingSessions.has(id)) return;
      const resumeToken = Symbol(id);
      let resolveResume!: () => void;
      const resumeOperation: ResumeOperation = {
        token: resumeToken,
        spawned: false,
        done: new Promise<void>((resolve) => {
          resolveResume = resolve;
        }),
        resolveDone: () => resolveResume(),
      };
      resumingSessions.set(id, resumeOperation);
      dispatch({ type: "SET_VIEW", view: "terminal" });
      let prepared = false;
      try {
        const terminalSize = await terminals.waitForViewport();
        if (resumingSessions.get(id) !== resumeOperation || closingTabs.has(id)) return;
        await terminals.prepareSession(id, terminalSize);
        if (resumingSessions.get(id) !== resumeOperation || closingTabs.has(id)) return;
        prepared = true;
        const session = await ipc.resumeSession(id, terminalSize);
        // The backend can finish spawning after Close cancels the frontend
        // token. Record that result before the cancellation check so a close
        // with stopOnClose disabled retains only a real live terminal.
        resumeOperation.spawned = true;
        if (resumingSessions.get(id) !== resumeOperation) return;
        terminals.commitSessionPreparation(id);
        dispatch({ type: "UPSERT_SESSION", session });
      } catch (e) {
        if (resumingSessions.get(id) !== resumeOperation) return;
        if (prepared) terminals.cancelSessionPreparation(id);
        const error = operationError("resume", previous.tool, e);
        dispatch({ type: "SET_RESUME_ERROR", id, error });
        showToast(error.message);
      } finally {
        resumeOperation.resolveDone();
        if (resumingSessions.get(id) === resumeOperation) resumingSessions.delete(id);
      }
    },
    async forkCodex(id) {
      if (!stateRef.current.bootReady) {
        showToast("Anchor is still restoring sessions.");
        return;
      }
      const source = stateRef.current.sessions.find((candidate) => candidate.id === id);
      if (!source || source.tool !== "codex" || forkingSessions.has(id)) return;
      forkingSessions.add(id);
      dispatch({ type: "SET_VIEW", view: "terminal" });
      try {
        const terminalSize = await terminals.waitForViewport();
        const session = await ipc.forkCodexSession(id, terminalSize);
        dispatch({ type: "SET_RESUME_ERROR", id, error: null });
        dispatch({ type: "UPSERT_SESSION", session });
        dispatch({ type: "OPEN_TAB", id: session.id });
        persistTabOpen(session.id, true);
      } catch (e) {
        const error = operationError("resume", "codex", e);
        dispatch({ type: "SET_RESUME_ERROR", id, error });
        showToast(error.message);
      } finally {
        forkingSessions.delete(id);
      }
    },
    // Closing a live session kills a running CLI, so `confirmClose` guards it.
    // The gate lives here rather than in the tab strip so every entry point —
    // the tab's close button and ⌘W alike — goes through one decision.
    async closeTab(id) {
      const session = stateRef.current.sessions.find((candidate) => candidate.id === id);
      if (stateRef.current.settings.confirmClose && session && isOn(session.status)) {
        dispatch({ type: "SET_CLOSE_CONFIRM", id });
        return;
      }
      await performClose(id);
    },
    async confirmCloseTab() {
      const id = stateRef.current.closeConfirmId;
      if (!id) return;
      dispatch({ type: "SET_CLOSE_CONFIRM", id: null });
      await performClose(id);
    },
    cancelCloseTab() {
      dispatch({ type: "SET_CLOSE_CONFIRM", id: null });
    },
    async stop(id) {
      try {
        await ipc.stopSession(id);
      } catch (e) {
        showToast(shortError(e));
      }
    },
    async deleteSession(id) {
      if (!stateRef.current.bootReady) {
        showToast("Anchor is still restoring sessions.");
        return;
      }
      try {
        await ipc.deleteSession(id);
        deletedSessionIds.add(id);
        resumingSessions.delete(id);
        // A permanent delete owns the final lifecycle state. Cancel an older
        // close so its failure path cannot restore a tab for the removed ID.
        closingTabs.delete(id);
        dispatch({ type: "REMOVE_SESSION", id });
        terminals.ignoreOutput(id);
      } catch (e) {
        showToast(shortError(e));
      }
    },
    async renameSession(id, title) {
      try {
        const session = await ipc.renameSession(id, title);
        dispatch({ type: "UPSERT_SESSION", session });
      } catch (e) {
        showToast(shortError(e));
      }
    },
    async setCodexProfile(id, codexProfile) {
      try {
        const session = await ipc.setCodexProfile(id, codexProfile);
        dispatch({ type: "UPSERT_SESSION", session });
        showToast(codexProfile ? `Codex profile set to ${codexProfile}` : "Codex base profile selected");
        return true;
      } catch (e) {
        showToast(shortError(e));
        return false;
      }
    },
    async addFolder(path) {
      try {
        const folder = await ipc.createFolder(path);
        dispatch({ type: "UPSERT_FOLDER", folder });
        return folder;
      } catch (e) {
        showToast(shortError(e));
        return null;
      }
    },
    async createProject(name) {
      try {
        const folder = await ipc.createProject(name);
        dispatch({ type: "UPSERT_FOLDER", folder });
        return folder;
      } catch (e) {
        showToast(shortError(e));
        return null;
      }
    },
    async renameFolder(id, name) {
      try {
        const folder = await ipc.renameFolder(id, name);
        dispatch({ type: "UPSERT_FOLDER", folder });
      } catch (e) {
        showToast(shortError(e));
      }
    },
    async removeFolder(id) {
      if (!stateRef.current.bootReady) {
        showToast("Anchor is still restoring sessions.");
        return;
      }
      const ids = stateRef.current.sessions.filter((s) => s.folderId === id).map((s) => s.id);
      try {
        await ipc.removeFolder(id);
        ids.forEach((sid) => deletedSessionIds.add(sid));
        ids.forEach((sid) => resumingSessions.delete(sid));
        ids.forEach((sid) => closingTabs.delete(sid));
        dispatch({ type: "REMOVE_FOLDER", id });
        ids.forEach((sid) => terminals.ignoreOutput(sid));
      } catch (e) {
        showToast(shortError(e));
      }
    },
    setFilter(value) {
      dispatch({ type: "SET_FILTER", value });
    },
    openPalette() {
      dispatch({ type: "SET_PALETTE", open: true });
    },
    closePalette() {
      dispatch({ type: "SET_PALETTE", open: false });
    },
    openNewSession(folderId) {
      dispatch({ type: "SET_NEW_SESSION", open: true, folderId });
    },
    closeNewSession() {
      dispatch({ type: "SET_NEW_SESSION", open: false });
    },
    openSettings() {
      dispatch({ type: "SET_VIEW", view: "settings" });
    },
    closeSettings() {
      dispatch({ type: "SET_VIEW", view: "terminal" });
    },
    setSettingsSection(section) {
      dispatch({ type: "SET_SETTINGS_SECTION", section });
    },
    async updateSettings(patch) {
      const next = { ...stateRef.current.settings, ...patch };
      dispatch({ type: "SET_SETTINGS", settings: next });
      applyTheme(next);
      if (patch.fontSize !== undefined) terminals.setFontSize(patch.fontSize);
      try {
        const saved = await ipc.setSettings(next);
        dispatch({ type: "SET_SETTINGS", settings: saved });
        applyTheme(saved);
      } catch (e) {
        showToast(shortError(e));
      }
    },
    copy(text, label) {
      try {
        void navigator.clipboard?.writeText(text);
      } catch {
        /* clipboard unavailable */
      }
      showToast(label);
    },
    dismissLaunchError() {
      dispatch({ type: "SET_LAUNCH_ERROR", error: null });
    },
    toast(text) {
      showToast(text);
    },
  };
}

function shortError(e: unknown): string {
  return operationError("resume", "terminal", e).message;
}

async function replayOutputWithRetry(sessionId: string): Promise<PtyReplay> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await ipc.replayOutput(sessionId);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

async function applyReplayWithRefresh(terminals: TerminalManager, sessionId: string): Promise<void> {
  for (let refresh = 0; refresh < 3; refresh += 1) {
    const replay = await replayOutputWithRetry(sessionId);
    if (await terminals.applyReplay(sessionId, replay)) return;
  }
  throw new Error("REPLAY_OVERFLOW: live output changed too quickly to rebuild the terminal safely");
}

function operationError(
  operation: OperationError["operation"],
  tool: Tool,
  error: unknown,
): OperationError {
  const raw = String(error).replace(/^Error:\s*/, "");
  const match = raw.match(/^([A-Z][A-Z0-9_]+):\s*(.+)$/);
  const code = match?.[1] ?? null;
  return {
    operation,
    tool,
    code,
    message: match?.[2] ?? raw,
    isCliNotFound: code === "CLI_NOT_FOUND",
  };
}
