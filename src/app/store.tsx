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
import type {
  CliInfo,
  Folder,
  HarnessDefinition,
  PtyReplay,
  Session,
  Settings,
  Tool,
  Workspace,
} from "../ipc/types";
import { isOn, orderIds, reconcileEmptyFolderSinceMs } from "./selectors";
import { applyTheme } from "./theme";
import { TerminalManager } from "./terminals";
import { SubmittedPromptCapture } from "./titleInput";
import { OrderedPtyWriter } from "./ptyInput";
import {
  DEFAULT_TERMINAL_THEME,
  DEFAULT_WORKSPACE,
  activeWorkspace,
  replaceWorkspace,
  workspaceIdForSession,
} from "./workspaces";

export type SettingsSection =
  | "general"
  | "appearance"
  | "notifications"
  | "terminal"
  | "harnesses"
  | "persistence"
  | "shortcuts"
  | "about";
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
  /** A neighbor selected by closing a tab is not evidence that the user read it. */
  autoSelectedId: string | null;
  /** Sidebar ordering: session id → sequence of the last submitted input. */
  submittedOrder: Record<string, number>;
  /** Monotonic counter backing `submittedOrder`. */
  submissionSeq: number;
  /** Sessions waiting for the completion of an input the user submitted. */
  awaitingResponses: Record<string, true>;
  /** Completed background responses that have not met the read-delay rule. */
  unreadResponses: Record<string, true>;
  workspacePaneOpen: boolean;
  /** Search text follows its workspace instead of leaking between contexts. */
  workspaceFilters: Record<string, string>;
  view: View;
  settingsSection: SettingsSection;
  filter: string;
  paletteOpen: boolean;
  newSessionOpen: boolean;
  /** When set, the wizard skips the folder step and launches into this folder. */
  newSessionFolderId: string | null;
  /** Tab awaiting close confirmation while an AI response is in progress. */
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
  accent: "#88a99d",
  notifyOnWaiting: false,
  responseReadDelayMs: 1000,
  favoriteSessionIds: [],
  folderOrder: [],
  tabOrder: [],
  emptyFolderSinceMs: {},
  workspaces: [DEFAULT_WORKSPACE],
  activeWorkspaceId: DEFAULT_WORKSPACE.id,
  sessionWorkspaceIds: {},
  workspacePaneKeepOpen: false,
  terminalTheme: DEFAULT_TERMINAL_THEME,
  customHarnesses: [],
  sessionHarnessIds: {},
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
  autoSelectedId: null,
  submittedOrder: {},
  submissionSeq: 0,
  awaitingResponses: {},
  unreadResponses: {},
  workspacePaneOpen: false,
  workspaceFilters: {},
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

function sessionUsesAiHarness(settings: Settings, session: Session): boolean {
  if (session.tool !== "terminal") return true;
  const harnessId = settings.sessionHarnessIds[session.id];
  return settings.customHarnesses.some((harness) => harness.id === harnessId && harness.kind === "ai");
}

type Action =
  | { type: "HYDRATE"; folders: Folder[]; sessions: Session[]; settings: Settings; clis: CliInfo[]; codexProfiles: string[]; openTabs: string[]; activeId: string | null }
  | { type: "RECONCILE_SESSIONS"; sessions: Session[] }
  | { type: "UPSERT_SESSION"; session: Session }
  | { type: "REMOVE_SESSION"; id: string }
  | { type: "SET_STATUS"; id: string; status: Session["status"] }
  | { type: "UPSERT_FOLDER"; folder: Folder }
  | { type: "REMOVE_FOLDER"; id: string }
  | { type: "OPEN_TAB"; id: string }
  | { type: "REORDER_TABS"; workspaceId: string; ids: string[] }
  | { type: "CLOSE_TAB"; id: string }
  | { type: "RESTORE_TAB"; id: string }
  | { type: "SET_ACTIVE"; id: string | null }
  | { type: "SESSION_SUBMITTED"; id: string; expectResponse: boolean }
  | { type: "MARK_RESPONSE_READ"; id: string }
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
  | { type: "SET_WORKSPACE_PANE"; open: boolean }
  | { type: "SWITCH_WORKSPACE"; id: string; activeId: string | null }
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

/** Drop deleted sessions from ephemeral per-session maps so they cannot grow unbounded. */
function withoutIds<T>(
  values: Record<string, T>,
  ids: string[],
): Record<string, T> {
  if (!ids.some((id) => id in values)) return values;
  const next = { ...values };
  for (const id of ids) delete next[id];
  return next;
}

function pickAdjacent(
  openTabs: string[],
  closingId: string,
  sessions: Session[],
  settings: Settings,
): string | null {
  const workspaceId = workspaceIdForSession(settings, closingId);
  const visible = openTabs.filter((id) => workspaceIdForSession(settings, id) === workspaceId);
  const i = visible.indexOf(closingId);
  const remaining = visible.filter((id) => id !== closingId && sessions.some((session) => session.id === id));
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
        workspacePaneOpen: action.settings.workspacePaneKeepOpen,
        filter: state.workspaceFilters[action.settings.activeWorkspaceId] ?? "",
      };
    case "RECONCILE_SESSIONS": {
      const ids = new Set(action.sessions.map((session) => session.id));
      const removedIds = state.sessions
        .filter((session) => !ids.has(session.id))
        .map((session) => session.id);
      const openTabs = state.openTabs.filter((id) => ids.has(id));
      const workspaceTabs = openTabs.filter((id) =>
        workspaceIdForSession(state.settings, id) === state.settings.activeWorkspaceId
      );
      const activeId = state.activeId && ids.has(state.activeId)
        ? state.activeId
        : workspaceTabs[workspaceTabs.length - 1] ?? null;
      const resumeErrors = Object.fromEntries(
        Object.entries(state.resumeErrors).filter(([id]) => ids.has(id)),
      );
      return {
        ...state,
        sessions: action.sessions,
        openTabs,
        activeId,
        submittedOrder: withoutIds(state.submittedOrder, removedIds),
        awaitingResponses: withoutIds(state.awaitingResponses, removedIds),
        unreadResponses: withoutIds(state.unreadResponses, removedIds),
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
        state.activeId === action.id
          ? pickAdjacent(state.openTabs, action.id, state.sessions, state.settings)
          : state.activeId;
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.id !== action.id),
        openTabs: state.openTabs.filter((t) => t !== action.id),
        activeId: active,
        autoSelectedId: state.activeId === action.id
          ? active
          : state.autoSelectedId === action.id ? null : state.autoSelectedId,
        submittedOrder: withoutIds(state.submittedOrder, [action.id]),
        awaitingResponses: withoutIds(state.awaitingResponses, [action.id]),
        unreadResponses: withoutIds(state.unreadResponses, [action.id]),
        closeConfirmId: state.closeConfirmId === action.id ? null : state.closeConfirmId,
      };
    }
    case "SET_STATUS": {
      let awaitingResponses = state.awaitingResponses;
      let unreadResponses = state.unreadResponses;
      if ((action.status === "waiting" || action.status === "stopped") && awaitingResponses[action.id]) {
        awaitingResponses = withoutIds(awaitingResponses, [action.id]);
        if (state.openTabs.includes(action.id) && state.activeId !== action.id) {
          unreadResponses = { ...unreadResponses, [action.id]: true };
        }
      }
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, status: action.status } : s,
        ),
        awaitingResponses,
        unreadResponses,
      };
    }
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
      const workspaceTabs = openTabs.filter((id) =>
        workspaceIdForSession(state.settings, id) === state.settings.activeWorkspaceId
      );
      const active = state.activeId && ids.has(state.activeId)
        ? workspaceTabs[workspaceTabs.length - 1] ?? null
        : state.activeId;
      return {
        ...state,
        folders: state.folders.filter((f) => f.id !== action.id),
        sessions: state.sessions.filter((s) => s.folderId !== action.id),
        openTabs,
        activeId: active,
        submittedOrder: withoutIds(state.submittedOrder, [...ids]),
        awaitingResponses: withoutIds(state.awaitingResponses, [...ids]),
        unreadResponses: withoutIds(state.unreadResponses, [...ids]),
      };
    }
    case "OPEN_TAB": {
      const openTabs = state.openTabs.includes(action.id)
        ? state.openTabs
        : [...state.openTabs, action.id];
      // A launch error is a transient pane overlay. Selecting any real session
      // must restore that session's terminal or Resume card instead of leaving
      // an unrelated failed launch on top of it.
      return {
        ...state,
        openTabs,
        activeId: action.id,
        autoSelectedId: null,
        view: "terminal",
        paletteOpen: false,
        launchError: null,
      };
    }
    case "CLOSE_TAB": {
      const active =
        state.activeId === action.id
          ? pickAdjacent(state.openTabs, action.id, state.sessions, state.settings)
          : state.activeId;
      return {
        ...state,
        openTabs: state.openTabs.filter((t) => t !== action.id),
        activeId: active,
        // Closing the current tab can expose an unread neighbor without any
        // user intent to read it. Only an explicit selection makes it eligible.
        autoSelectedId: state.activeId === action.id ? active : state.autoSelectedId,
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
      return {
        ...state,
        openTabs,
        activeId: state.activeId ?? action.id,
        autoSelectedId: state.activeId === null ? action.id : state.autoSelectedId,
      };
    }
    case "SET_ACTIVE":
      return { ...state, activeId: action.id, view: "terminal", launchError: null };
    case "SESSION_SUBMITTED": {
      const submissionSeq = state.submissionSeq + 1;
      return {
        ...state,
        submissionSeq,
        submittedOrder: { ...state.submittedOrder, [action.id]: submissionSeq },
        awaitingResponses: action.expectResponse
          ? { ...state.awaitingResponses, [action.id]: true }
          : withoutIds(state.awaitingResponses, [action.id]),
        unreadResponses: withoutIds(state.unreadResponses, [action.id]),
        autoSelectedId: state.autoSelectedId === action.id ? null : state.autoSelectedId,
      };
    }
    case "REORDER_TABS": {
      const current = state.openTabs.filter((id) =>
        workspaceIdForSession(state.settings, id) === action.workspaceId
      );
      const currentIds = new Set(current);
      if (action.ids.length !== current.length
        || action.ids.some((id) => !currentIds.has(id))
        || new Set(action.ids).size !== action.ids.length) return state;
      let replacement = 0;
      return {
        ...state,
        openTabs: state.openTabs.map((id) =>
          workspaceIdForSession(state.settings, id) === action.workspaceId
            ? action.ids[replacement++] ?? id
            : id
        ),
      };
    }
    case "MARK_RESPONSE_READ":
      return state.unreadResponses[action.id]
        ? { ...state, unreadResponses: withoutIds(state.unreadResponses, [action.id]) }
        : state;
    case "SET_VIEW":
      return { ...state, view: action.view };
    case "SET_SETTINGS_SECTION":
      return { ...state, settingsSection: action.section };
    case "SET_FILTER":
      return {
        ...state,
        filter: action.value,
        workspaceFilters: {
          ...state.workspaceFilters,
          [state.settings.activeWorkspaceId]: action.value,
        },
      };
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
    case "SET_WORKSPACE_PANE":
      return { ...state, workspacePaneOpen: action.open };
    case "SWITCH_WORKSPACE":
      return {
        ...state,
        activeId: action.activeId,
        autoSelectedId: action.activeId,
        filter: state.workspaceFilters[action.id] ?? "",
        view: "terminal",
        paletteOpen: false,
        launchError: null,
      };
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
  const titleInput = useRef(new SubmittedPromptCapture()).current;
  const ptyInput = useMemo(
    () => new OrderedPtyWriter((sessionId, data) => ipc.writePty(sessionId, data)),
    [],
  );
  const activeHasReadableResponse = state.activeId !== null
    && state.autoSelectedId !== state.activeId
    && Boolean(state.unreadResponses[state.activeId]);

  useEffect(() => {
    const id = state.activeId;
    if (!id || !activeHasReadableResponse) return;
    // A quick Ctrl+Tab pass is navigation, not reading. Clear only if this chat
    // remains selected for the user's configured dwell time.
    const timer = window.setTimeout(() => {
      if (stateRef.current.activeId === id) {
        dispatch({ type: "MARK_RESPONSE_READ", id });
      }
    }, state.settings.responseReadDelayMs);
    return () => window.clearTimeout(timer);
  }, [state.activeId, state.autoSelectedId, state.settings.responseReadDelayMs, activeHasReadableResponse]);

  // Toast auto-dismiss.
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useRef((text: string) => {
    dispatch({ type: "SET_TOAST", text });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => dispatch({ type: "SET_TOAST", text: null }), 1600);
  }).current;

  const terminals = useMemo(
    () => {
      // xterm's onData contains only user input. Reordering and response
      // attention wait for a completed line so browsing or partial typing can
      // never move a sidebar row.
      const manager = new TerminalManager((sessionId, data) => {
        const prompt = titleInput.observe(sessionId, data);
        void ptyInput.write(sessionId, data).then(() => {
          if (!prompt || deletedSessionIds.current.has(sessionId)) return;
          const session = stateRef.current.sessions.find((candidate) => candidate.id === sessionId);
          if (!session) return;
          dispatch({
            type: "SESSION_SUBMITTED",
            id: sessionId,
            expectResponse: sessionUsesAiHarness(stateRef.current.settings, session),
          });
          if (prompt.titleMessage && session.tool !== "terminal") {
            void ipc.generateSessionTitle(sessionId, prompt.titleMessage).then((updated) => {
              if (!deletedSessionIds.current.has(updated.id)) {
                dispatch({ type: "UPSERT_SESSION", session: updated });
              }
            }).catch((error) => showToast(shortError(error)));
          }
        }).catch(() => {
          // The terminal owns write-error presentation; failed input must not
          // count as a submitted message or arm response attention.
        });
      },
      (sessionId, size) => ipc.resizePty(sessionId, size.cols, size.rows),
      (_sessionId, error) => showToast(`Terminal resize failed: ${shortError(error)}`));
      manager.beginReplayCapture();
      return manager;
    },
    [ptyInput, showToast, titleInput],
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
        terminals.setTheme(settings.terminalTheme);
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
        const orderedRestoredTabs = settings.workspaces.flatMap((workspace) =>
          orderIds(
            restoredTabs.filter((id) => workspaceIdForSession(settings, id) === workspace.id),
            workspace.tabOrder,
          )
        );
        const initialWorkspace = activeWorkspace(settings);
        const initialActiveId = orderedRestoredTabs.find((id) =>
          workspaceIdForSession(settings, id) === initialWorkspace.id
        ) ?? null;
        dispatch({
          type: "HYDRATE",
          folders: snapshot.folders,
          sessions: hydratedSessions,
          settings,
          clis,
          codexProfiles,
          openTabs: orderedRestoredTabs,
          activeId: initialActiveId,
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
    () => makeActions(dispatch, stateRef, terminals, deletedSessionIds.current, showToast, titleInput),
    [terminals, showToast, titleInput],
  );

  // Persist the start of each continuous empty interval. Deriving this from
  // registry state also clears the timestamp as soon as a session is added.
  useEffect(() => {
    if (!state.loaded) return;
    const next = reconcileEmptyFolderSinceMs(
      state.folders,
      state.sessions,
      state.settings.emptyFolderSinceMs,
      Date.now(),
    );
    if (next !== state.settings.emptyFolderSinceMs) {
      void actions.updateSettings({ emptyFolderSinceMs: next });
    }
  }, [actions, state.folders, state.loaded, state.sessions, state.settings.emptyFolderSinceMs]);

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
  reorderTabs(ids: string[]): Promise<void>;
  launch(tool: Tool, folderId: string, codexProfile?: string | null): Promise<void>;
  launchCustomHarness(harnessId: string, folderId: string): Promise<void>;
  resume(id: string): Promise<void>;
  repairIdentity(id: string): Promise<void>;
  forkCodex(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  /** Sidebar minimize is an explicit no-warning close; lifecycle behavior stays in performClose. */
  closeTabImmediately(id: string): Promise<void>;
  confirmCloseTab(): Promise<void>;
  cancelCloseTab(): void;
  stop(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  toggleFavoriteSession(id: string): Promise<void>;
  setSessionId(id: string, cliSessionId: string): Promise<boolean>;
  setCodexProfile(id: string, codexProfile: string | null): Promise<boolean>;
  addFolder(path: string): Promise<Folder | null>;
  createProject(name: string): Promise<Folder | null>;
  renameFolder(id: string, name: string): Promise<void>;
  reorderFolders(folderIds: string[]): Promise<void>;
  toggleFolderCollapsed(folderId: string): Promise<void>;
  removeFolder(id: string): Promise<void>;
  toggleWorkspacePane(open?: boolean): void;
  selectWorkspace(id: string): Promise<void>;
  createWorkspace(name: string): Promise<Workspace | null>;
  renameWorkspace(id: string, name: string): Promise<void>;
  toggleWorkspacePinned(id: string): Promise<void>;
  setWorkspaceArchived(id: string, archived: boolean): Promise<void>;
  moveSessionToWorkspace(sessionId: string, workspaceId: string): Promise<void>;
  saveHarness(harness: HarnessDefinition): Promise<void>;
  removeHarness(id: string): Promise<void>;
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
  titleInput: SubmittedPromptCapture,
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

  // Settings controls can fire faster than React publishes the latest state.
  // Keep one optimistic draft and serialize full-object writes so a quick
  // favorite toggle or drag cannot overwrite another in-flight setting.
  let settingsDraft: Settings | null = null;
  let settingsWrite: Promise<void> = Promise.resolve();
  let settingsRevision = 0;
  const currentSettings = () => settingsDraft ?? stateRef.current.settings;
  async function persistSettingsPatch(patch: Partial<Settings>): Promise<void> {
    const previous = currentSettings();
    const next = { ...previous, ...patch };
    const revision = ++settingsRevision;
    settingsDraft = next;
    dispatch({ type: "SET_SETTINGS", settings: next });
    applyTheme(next);
    if (patch.fontSize !== undefined) terminals.setFontSize(patch.fontSize);
    if (patch.terminalTheme !== undefined) terminals.setTheme(patch.terminalTheme);

    const write = settingsWrite
      .catch(() => {})
      .then(async () => {
        const saved = await ipc.setSettings(next);
        if (revision === settingsRevision) {
          settingsDraft = null;
          dispatch({ type: "SET_SETTINGS", settings: saved });
          applyTheme(saved);
          terminals.setTheme(saved.terminalTheme);
        }
      });
    settingsWrite = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      if (revision === settingsRevision) {
        settingsDraft = null;
        dispatch({ type: "SET_SETTINGS", settings: previous });
        applyTheme(previous);
        terminals.setFontSize(previous.fontSize);
        terminals.setTheme(previous.terminalTheme);
      }
      showToast(shortError(error));
    }
  }

  const persistWorkspaceUpdate = async (
    workspaceId: string,
    update: (workspace: Workspace) => Workspace,
    patch: Partial<Settings> = {},
  ) => {
    const settings = currentSettings();
    await persistSettingsPatch({
      ...patch,
      workspaces: replaceWorkspace(settings, workspaceId, update),
    });
  };

  const orderedOpenTabsForWorkspace = (workspaceId: string): string[] => {
    const current = stateRef.current;
    const workspace = current.settings.workspaces.find((item) => item.id === workspaceId);
    const ids = current.openTabs.filter((id) =>
      workspaceIdForSession(current.settings, id) === workspaceId
    );
    return orderIds(ids, workspace?.tabOrder ?? []);
  };

  // Tabs with a close request still in flight, keyed to the token of the
  // request that owns them. Reopening a tab clears its token, so a close that
  // settles afterwards neither disposes the terminal nor undoes the reopen.
  const closingTabs = new Map<string, symbol>();
  const deletingSessions = new Set<string>();
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
      const settings = currentSettings();
      const workspaceId = workspaceIdForSession(settings, id);
      await persistWorkspaceUpdate(workspaceId, (workspace) => ({
        ...workspace,
        tabOrder: workspace.tabOrder.filter((candidate) => candidate !== id),
      }));
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

  async function performIdentityRepair(id: string): Promise<void> {
    if (!stateRef.current.bootReady) {
      showToast("Anchor is still restoring sessions.");
      return;
    }
    const previous = stateRef.current.sessions.find((candidate) => candidate.id === id);
    if (!previous || previous.tool === "terminal" || previous.cliSessionId) return;
    if (resumingSessions.has(id)) return;
    dispatch({ type: "SET_RESUME_ERROR", id, error: null });
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
      const session = await ipc.repairSessionIdentity(id, terminalSize);
      resumeOperation.spawned = true;
      if (resumingSessions.get(id) !== resumeOperation) return;
      terminals.commitSessionPreparation(id);
      dispatch({ type: "UPSERT_SESSION", session });
    } catch (error) {
      if (resumingSessions.get(id) !== resumeOperation) return;
      if (prepared) terminals.cancelSessionPreparation(id);
      const operation = operationError("resume", previous.tool, error);
      dispatch({ type: "SET_RESUME_ERROR", id, error: operation });
      showToast(operation.message);
    } finally {
      resumeOperation.resolveDone();
      if (resumingSessions.get(id) === resumeOperation) resumingSessions.delete(id);
    }
  }

  return {
    selectSession(id) {
      closingTabs.delete(id);
      const current = stateRef.current;
      const already = current.openTabs.includes(id);
      const workspaceId = workspaceIdForSession(current.settings, id);
      const workspace = current.settings.workspaces.find((item) => item.id === workspaceId)
        ?? DEFAULT_WORKSPACE;
      const tabOrder = workspace.tabOrder.includes(id)
        ? workspace.tabOrder
        : [...workspace.tabOrder, id];
      void persistWorkspaceUpdate(
        workspaceId,
        (item) => ({ ...item, tabOrder }),
        { activeWorkspaceId: workspaceId },
      );
      if (workspaceId !== current.settings.activeWorkspaceId) {
        dispatch({ type: "SWITCH_WORKSPACE", id: workspaceId, activeId: id });
      }
      if (!current.settings.workspacePaneKeepOpen) {
        dispatch({ type: "SET_WORKSPACE_PANE", open: false });
      }
      dispatch({ type: "OPEN_TAB", id });
      if (!already) persistTabOpen(id, true);
    },
    async reorderTabs(ids) {
      const workspace = activeWorkspace(stateRef.current.settings);
      const current = orderedOpenTabsForWorkspace(workspace.id);
      if (ids.length === current.length && ids.every((id, index) => id === current[index])) return;
      dispatch({ type: "REORDER_TABS", workspaceId: workspace.id, ids });
      await persistWorkspaceUpdate(workspace.id, (item) => ({ ...item, tabOrder: ids }));
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
        const settings = currentSettings();
        const workspace = activeWorkspace(settings);
        // The PTY is already running. Publish its tab immediately while the
        // durable workspace-order write completes in the background.
        const workspaceWrite = persistWorkspaceUpdate(workspace.id, (item) => ({
          ...item,
          tabOrder: item.tabOrder.includes(session.id)
            ? item.tabOrder
            : [...item.tabOrder, session.id],
        }), {
          sessionWorkspaceIds: {
            ...settings.sessionWorkspaceIds,
            [session.id]: workspace.id,
          },
        });
        dispatch({ type: "SET_LAUNCH_ERROR", error: null });
        dispatch({ type: "UPSERT_SESSION", session });
        dispatch({ type: "OPEN_TAB", id: session.id });
        persistTabOpen(session.id, true);
        await workspaceWrite;
      } catch (e) {
        const baseError = operationError("launch", tool, e);
        const error: LaunchError = { ...baseError, operation: "launch", folderId };
        dispatch({ type: "SET_LAUNCH_ERROR", error });
        showToast(error.message);
      }
    },
    async launchCustomHarness(harnessId, folderId) {
      if (!stateRef.current.bootReady) {
        showToast("Anchor is still restoring sessions.");
        return;
      }
      const harness = currentSettings().customHarnesses.find((item) => item.id === harnessId);
      if (!harness || !harness.enabled) {
        showToast("This custom harness is not available.");
        return;
      }
      dispatch({ type: "SET_LAUNCH_ERROR", error: null });
      dispatch({ type: "SET_VIEW", view: "terminal" });
      try {
        const terminalSize = await terminals.waitForViewport();
        const session = await ipc.launchCustomSession(folderId, harnessId, terminalSize);
        // The backend commits the harness/session relationship before spawning.
        // Refresh first so the following workspace write cannot erase that mapping.
        const refreshed = await ipc.getSettings();
        settingsDraft = refreshed;
        dispatch({ type: "SET_SETTINGS", settings: refreshed });
        applyTheme(refreshed);
        terminals.setTheme(refreshed.terminalTheme);
        const workspace = activeWorkspace(refreshed);
        const workspaceWrite = persistWorkspaceUpdate(workspace.id, (item) => ({
          ...item,
          tabOrder: item.tabOrder.includes(session.id)
            ? item.tabOrder
            : [...item.tabOrder, session.id],
        }), {
          sessionWorkspaceIds: {
            ...refreshed.sessionWorkspaceIds,
            [session.id]: workspace.id,
          },
        });
        dispatch({ type: "UPSERT_SESSION", session });
        dispatch({ type: "OPEN_TAB", id: session.id });
        persistTabOpen(session.id, true);
        await workspaceWrite;
      } catch (error) {
        const baseError = operationError("launch", "terminal", error);
        const launchError: LaunchError = { ...baseError, operation: "launch", folderId };
        dispatch({ type: "SET_LAUNCH_ERROR", error: launchError });
        showToast(launchError.message);
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
        await performIdentityRepair(id);
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
    async repairIdentity(id) {
      await performIdentityRepair(id);
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
        const settings = currentSettings();
        const workspaceId = workspaceIdForSession(settings, source.id);
        await persistWorkspaceUpdate(workspaceId, (workspace) => ({
          ...workspace,
          tabOrder: workspace.tabOrder.includes(session.id)
            ? workspace.tabOrder
            : [...workspace.tabOrder, session.id],
        }), {
          sessionWorkspaceIds: {
            ...settings.sessionWorkspaceIds,
            [session.id]: workspaceId,
          },
        });
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
    // A live CLI can sit idle indefinitely. Warn only when Anchor has an armed
    // AI response and this close would stop it; unknown activity fails open.
    // The gate stays here so the tab button and ⌘W share one decision.
    async closeTab(id) {
      const current = stateRef.current;
      if (
        current.settings.confirmClose
        && current.settings.stopOnClose
        && current.awaitingResponses[id]
      ) {
        dispatch({ type: "SET_CLOSE_CONFIRM", id });
        return;
      }
      await performClose(id);
    },
    async closeTabImmediately(id) {
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
      if (deletingSessions.has(id)) return;
      const previous = stateRef.current.sessions.find((session) => session.id === id);
      if (!previous) return;
      const wasOpen = stateRef.current.openTabs.includes(id);
      const wasActive = stateRef.current.activeId === id;

      // Windows can spend several seconds stopping ConPTY before the delete
      // command returns. Remove the record immediately and tombstone its event
      // stream so one click has visible, single-shot behavior during that wait.
      deletingSessions.add(id);
      deletedSessionIds.add(id);
      resumingSessions.delete(id);
      closingTabs.delete(id);
      dispatch({ type: "REMOVE_SESSION", id });
      terminals.ignoreOutput(id);
      try {
        await ipc.deleteSession(id);
        titleInput.forget(id);
        const settings = currentSettings();
        await persistSettingsPatch({
          workspaces: settings.workspaces.map((workspace) => ({
            ...workspace,
            favoriteSessionIds: workspace.favoriteSessionIds.filter((candidate) => candidate !== id),
            tabOrder: workspace.tabOrder.filter((candidate) => candidate !== id),
          })),
          sessionWorkspaceIds: Object.fromEntries(
            Object.entries(settings.sessionWorkspaceIds).filter(([sessionId]) => sessionId !== id),
          ),
          sessionHarnessIds: Object.fromEntries(
            Object.entries(settings.sessionHarnessIds).filter(([sessionId]) => sessionId !== id),
          ),
        });
      } catch (e) {
        deletedSessionIds.delete(id);
        terminals.allowOutput(id);
        const authoritative = await ipc.getState().catch(() => null);
        const restored = authoritative
          ? authoritative.sessions.find((session) => session.id === id)
          : previous;
        if (restored) {
          dispatch({ type: "UPSERT_SESSION", session: restored });
          if (wasOpen) dispatch({ type: "RESTORE_TAB", id });
          if (wasActive) dispatch({ type: "SET_ACTIVE", id });
        } else {
          // The delete command failed after another actor removed the record.
          // Keep the authoritative absence instead of reviving stale events.
          deletedSessionIds.add(id);
          terminals.ignoreOutput(id);
        }
        showToast(shortError(e));
      } finally {
        deletingSessions.delete(id);
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
    async toggleFavoriteSession(id) {
      const settings = currentSettings();
      const workspaceId = workspaceIdForSession(settings, id);
      const workspace = settings.workspaces.find((item) => item.id === workspaceId)
        ?? DEFAULT_WORKSPACE;
      const favorites = workspace.favoriteSessionIds;
      const favoriteSessionIds = favorites.includes(id)
        ? favorites.filter((candidate) => candidate !== id)
        : [...favorites, id];
      await persistWorkspaceUpdate(workspaceId, (item) => ({ ...item, favoriteSessionIds }));
    },
    async setSessionId(id, cliSessionId) {
      try {
        const session = await ipc.setSessionId(id, cliSessionId);
        dispatch({ type: "UPSERT_SESSION", session });
        dispatch({ type: "SET_RESUME_ERROR", id, error: null });
        showToast("Session ID saved");
        return true;
      } catch (error) {
        showToast(shortError(error));
        return false;
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
    async reorderFolders(folderIds) {
      const known = new Set(stateRef.current.folders.map((folder) => folder.id));
      if (
        folderIds.length !== known.size
        || new Set(folderIds).size !== known.size
        || folderIds.some((id) => !known.has(id))
      ) return;
      const workspace = activeWorkspace(currentSettings());
      await persistWorkspaceUpdate(workspace.id, (item) => ({ ...item, folderOrder: folderIds }));
    },
    async toggleFolderCollapsed(folderId) {
      const workspace = activeWorkspace(currentSettings());
      const collapsedFolderIds = workspace.collapsedFolderIds.includes(folderId)
        ? workspace.collapsedFolderIds.filter((id) => id !== folderId)
        : [...workspace.collapsedFolderIds, folderId];
      await persistWorkspaceUpdate(workspace.id, (item) => ({ ...item, collapsedFolderIds }));
    },
    async removeFolder(id) {
      if (!stateRef.current.bootReady) {
        showToast("Anchor is still restoring sessions.");
        return;
      }
      const ids = stateRef.current.sessions.filter((s) => s.folderId === id).map((s) => s.id);
      const removedIds = new Set(ids);
      try {
        await ipc.removeFolder(id);
        ids.forEach((sid) => deletedSessionIds.add(sid));
        ids.forEach((sid) => resumingSessions.delete(sid));
        ids.forEach((sid) => closingTabs.delete(sid));
        dispatch({ type: "REMOVE_FOLDER", id });
        ids.forEach((sid) => titleInput.forget(sid));
        ids.forEach((sid) => terminals.ignoreOutput(sid));
        await persistSettingsPatch({
          favoriteSessionIds: currentSettings().favoriteSessionIds.filter((sid) => !removedIds.has(sid)),
          folderOrder: currentSettings().folderOrder.filter((folderId) => folderId !== id),
          workspaces: currentSettings().workspaces.map((workspace) => ({
            ...workspace,
            favoriteSessionIds: workspace.favoriteSessionIds.filter((sid) => !removedIds.has(sid)),
            tabOrder: workspace.tabOrder.filter((sid) => !removedIds.has(sid)),
            folderOrder: workspace.folderOrder.filter((folderId) => folderId !== id),
            collapsedFolderIds: workspace.collapsedFolderIds.filter((folderId) => folderId !== id),
          })),
          sessionWorkspaceIds: Object.fromEntries(
            Object.entries(currentSettings().sessionWorkspaceIds)
              .filter(([sessionId]) => !removedIds.has(sessionId)),
          ),
          sessionHarnessIds: Object.fromEntries(
            Object.entries(currentSettings().sessionHarnessIds)
              .filter(([sessionId]) => !removedIds.has(sessionId)),
          ),
          emptyFolderSinceMs: Object.fromEntries(
            Object.entries(currentSettings().emptyFolderSinceMs)
              .filter(([folderId]) => folderId !== id),
          ),
        });
      } catch (e) {
        showToast(shortError(e));
      }
    },
    toggleWorkspacePane(open) {
      dispatch({
        type: "SET_WORKSPACE_PANE",
        open: open ?? !stateRef.current.workspacePaneOpen,
      });
    },
    async selectWorkspace(id) {
      const settings = currentSettings();
      const workspace = settings.workspaces.find((item) => item.id === id && !item.archived);
      if (!workspace) return;
      const activeId = orderedOpenTabsForWorkspace(id)[0] ?? null;
      dispatch({ type: "SWITCH_WORKSPACE", id, activeId });
      if (!settings.workspacePaneKeepOpen) {
        dispatch({ type: "SET_WORKSPACE_PANE", open: false });
      }
      await persistSettingsPatch({ activeWorkspaceId: id });
    },
    async createWorkspace(name) {
      const clean = name.trim();
      if (!clean) return null;
      const workspace: Workspace = {
        id: crypto.randomUUID(),
        name: clean,
        pinned: false,
        archived: false,
        favoriteSessionIds: [],
        folderOrder: stateRef.current.folders.map((folder) => folder.id),
        tabOrder: [],
        collapsedFolderIds: [],
      };
      const settings = currentSettings();
      await persistSettingsPatch({ workspaces: [...settings.workspaces, workspace] });
      return workspace;
    },
    async renameWorkspace(id, name) {
      const clean = name.trim();
      if (!clean) return;
      await persistWorkspaceUpdate(id, (workspace) => ({ ...workspace, name: clean }));
    },
    async toggleWorkspacePinned(id) {
      await persistWorkspaceUpdate(id, (workspace) => ({
        ...workspace,
        pinned: !workspace.pinned,
      }));
    },
    async setWorkspaceArchived(id, archived) {
      if (id === DEFAULT_WORKSPACE.id) {
        showToast("The Default workspace cannot be archived.");
        return;
      }
      const settings = currentSettings();
      const next = replaceWorkspace(settings, id, (workspace) => ({ ...workspace, archived }));
      let activeWorkspaceId = settings.activeWorkspaceId;
      if (archived && activeWorkspaceId === id) {
        activeWorkspaceId = next.find((workspace) => !workspace.archived)?.id ?? DEFAULT_WORKSPACE.id;
      }
      await persistSettingsPatch({ workspaces: next, activeWorkspaceId });
      if (activeWorkspaceId !== settings.activeWorkspaceId) {
        dispatch({
          type: "SWITCH_WORKSPACE",
          id: activeWorkspaceId,
          activeId: orderedOpenTabsForWorkspace(activeWorkspaceId)[0] ?? null,
        });
      }
    },
    async moveSessionToWorkspace(sessionId, workspaceId) {
      const settings = currentSettings();
      const destination = settings.workspaces.find((workspace) =>
        workspace.id === workspaceId && !workspace.archived
      );
      if (!destination) return;
      const sourceId = workspaceIdForSession(settings, sessionId);
      if (sourceId === workspaceId) return;
      const isOpen = stateRef.current.openTabs.includes(sessionId);
      const source = settings.workspaces.find((workspace) => workspace.id === sourceId);
      const wasFavorite = source?.favoriteSessionIds.includes(sessionId) ?? false;
      const nextSourceActiveId = orderedOpenTabsForWorkspace(sourceId)
        .find((id) => id !== sessionId) ?? null;
      const workspaces = settings.workspaces.map((workspace) => {
        if (workspace.id === sourceId) {
          return {
            ...workspace,
            favoriteSessionIds: workspace.favoriteSessionIds.filter((id) => id !== sessionId),
            tabOrder: workspace.tabOrder.filter((id) => id !== sessionId),
          };
        }
        if (workspace.id === workspaceId) {
          return {
            ...workspace,
            favoriteSessionIds: wasFavorite && !workspace.favoriteSessionIds.includes(sessionId)
              ? [...workspace.favoriteSessionIds, sessionId]
              : workspace.favoriteSessionIds,
            tabOrder: isOpen && !workspace.tabOrder.includes(sessionId)
              ? [...workspace.tabOrder, sessionId]
              : workspace.tabOrder,
          };
        }
        return workspace;
      });
      await persistSettingsPatch({
        workspaces,
        sessionWorkspaceIds: { ...settings.sessionWorkspaceIds, [sessionId]: workspaceId },
      });
      if (stateRef.current.activeId === sessionId && settings.activeWorkspaceId === sourceId) {
        dispatch({ type: "SET_ACTIVE", id: nextSourceActiveId });
      }
      showToast(`Moved to ${destination.name}`);
    },
    async saveHarness(harness) {
      const settings = currentSettings();
      const exists = settings.customHarnesses.some((item) => item.id === harness.id);
      const customHarnesses = exists
        ? settings.customHarnesses.map((item) => item.id === harness.id ? harness : item)
        : [...settings.customHarnesses, harness];
      await persistSettingsPatch({ customHarnesses });
      showToast("Harness saved");
    },
    async removeHarness(id) {
      const settings = currentSettings();
      if (Object.values(settings.sessionHarnessIds).includes(id)) {
        showToast("Remove or reassign this harness's saved sessions first.");
        return;
      }
      await persistSettingsPatch({
        customHarnesses: settings.customHarnesses.filter((harness) => harness.id !== id),
      });
      showToast("Harness removed");
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
      await persistSettingsPatch(patch);
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
