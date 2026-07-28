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
  onSessionStatus,
  onSessionUpdated,
} from "../ipc/events";
import type { CliInfo, Folder, Session, Settings, Tool } from "../ipc/types";
import { isOn } from "./selectors";
import { applyTheme } from "./theme";
import { TerminalManager } from "./terminals";

export type SettingsSection = "general" | "persistence" | "appearance" | "shortcuts";
export type View = "terminal" | "settings";

interface State {
  loaded: boolean;
  folders: Folder[];
  sessions: Session[];
  settings: Settings;
  clis: CliInfo[];
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
  folders: [],
  sessions: [],
  settings: DEFAULT_SETTINGS,
  clis: [],
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
  toast: null,
  waitingCount: 0,
  fatalError: null,
};

type Action =
  | { type: "HYDRATE"; folders: Folder[]; sessions: Session[]; settings: Settings; clis: CliInfo[]; openTabs: string[]; activeId: string | null }
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
  | { type: "SET_TOAST"; text: string | null }
  | { type: "SET_SETTINGS"; settings: Settings }
  | { type: "SET_WAITING"; count: number }
  | { type: "FATAL"; message: string };

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
        openTabs: action.openTabs,
        activeId: action.activeId,
      };
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
      return { ...state, openTabs, activeId: action.id, view: "terminal", paletteOpen: false };
    }
    case "CLOSE_TAB": {
      const active =
        state.activeId === action.id ? pickAdjacent(state.openTabs, action.id) : state.activeId;
      return { ...state, openTabs: state.openTabs.filter((t) => t !== action.id), activeId: active };
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
      return { ...state, activeId: action.id, view: "terminal" };
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
    case "SET_TOAST":
      return { ...state, toast: action.text };
    case "SET_SETTINGS":
      return { ...state, settings: action.settings };
    case "SET_WAITING":
      return { ...state, waitingCount: action.count };
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

  const terminals = useMemo(
    () =>
      // This callback is xterm's onData — real user keystrokes only, never PTY
      // output — so it is the right signal for activity-based sidebar order.
      new TerminalManager((sessionId, data) => {
        dispatch({ type: "SESSION_TYPED", id: sessionId });
        void ipc.writePty(sessionId, data).catch(() => {});
      }),
    [],
  );

  // Toast auto-dismiss.
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useRef((text: string) => {
    dispatch({ type: "SET_TOAST", text });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => dispatch({ type: "SET_TOAST", text: null }), 1600);
  }).current;

  // Boot: subscribe to events, load state/settings/clis, restore tabs, then
  // tell the backend the frontend is ready. Listeners come first so PTY output
  // and status emitted by auto-restore cannot be lost (SPEC.md §8), and
  // `frontend_ready` comes last so restore never races hydration.
  useEffect(() => {
    let unlisten: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      try {
        const subs = await Promise.all([
          onPtyOutput((p) => terminals.write(p.sessionId, p.data)),
          onSessionStatus((p) => dispatch({ type: "SET_STATUS", id: p.sessionId, status: p.status })),
          onSessionUpdated((s) => dispatch({ type: "UPSERT_SESSION", session: s })),
          onAttentionCount((p) => dispatch({ type: "SET_WAITING", count: p.waiting })),
        ]);
        if (cancelled) {
          subs.forEach((u) => u());
          return;
        }
        unlisten = subs;

        const [snapshot, settings, clis] = await Promise.all([
          ipc.getState(),
          ipc.getSettings(),
          ipc.detectClis(),
        ]);
        if (cancelled) return;

        applyTheme(settings);

        const restore = settings.autoRestore;
        const restoredTabs = restore
          ? snapshot.sessions.filter((s) => s.wasOpenInTab).map((s) => s.id)
          : [];
        dispatch({
          type: "HYDRATE",
          folders: snapshot.folders,
          sessions: snapshot.sessions,
          settings,
          clis,
          openTabs: restoredTabs,
          activeId: restoredTabs[0] ?? null,
        });

        // A page reload (dev HMR, ⌘R, webview recreation) destroys every xterm
        // buffer while the PTYs keep running, so a still-live session would
        // come back blank. The core holds the only other copy — ask it to
        // resend (SPEC.md §8). Sessions started by auto-restore below have
        // printed nothing yet and need no replay.
        for (const session of snapshot.sessions) {
          if (isOn(session.status) && terminals.claimReplay(session.id)) {
            void ipc.replayOutput(session.id).catch(() => {});
          }
        }

        // HYDRATE is queued before any status event auto-restore can produce,
        // so restored `running` sessions are not overwritten by this snapshot.
        await ipc.frontendReady();
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
    () => makeActions(dispatch, stateRef, terminals, showToast),
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
  launch(tool: Tool, folderId: string): Promise<void>;
  resume(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
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
  toast(text: string): void;
}

function makeActions(
  dispatch: React.Dispatch<Action>,
  stateRef: React.MutableRefObject<State>,
  terminals: TerminalManager,
  showToast: (text: string) => void,
): Actions {
  const persistTabOpen = (id: string, open: boolean) => {
    void ipc.setTabOpen(id, open).catch(() => {});
  };

  // Tabs with a close request still in flight, keyed to the token of the
  // request that owns them. Reopening a tab clears its token, so a close that
  // settles afterwards neither disposes the terminal nor undoes the reopen.
  const closingTabs = new Map<string, symbol>();

  return {
    selectSession(id) {
      closingTabs.delete(id);
      const already = stateRef.current.openTabs.includes(id);
      dispatch({ type: "OPEN_TAB", id });
      if (!already) persistTabOpen(id, true);
    },
    async launch(tool, folderId) {
      try {
        const session = await ipc.launchSession(folderId, tool);
        dispatch({ type: "UPSERT_SESSION", session });
        dispatch({ type: "OPEN_TAB", id: session.id });
        persistTabOpen(session.id, true);
      } catch (e) {
        showToast(shortError(e));
      }
    },
    async resume(id) {
      try {
        const session = await ipc.resumeSession(id);
        dispatch({ type: "UPSERT_SESSION", session });
      } catch (e) {
        showToast(shortError(e));
      }
    },
    // `set_tab_open(false)` is the sole close lifecycle command: with
    // stopOnClose the backend stops the PTY itself, so a second stop_session
    // here would only queue behind work already done (SPEC.md §8). The tab
    // disappears immediately; shutdown finishes in the background.
    async closeTab(id) {
      const session = stateRef.current.sessions.find((candidate) => candidate.id === id);
      const stopOnClose = stateRef.current.settings.stopOnClose;
      const closeToken = Symbol(id);
      closingTabs.set(id, closeToken);
      dispatch({ type: "CLOSE_TAB", id });

      try {
        await ipc.setTabOpen(id, false);
        if (closingTabs.get(id) !== closeToken) return;
        closingTabs.delete(id);
        if (session && (!isOn(session.status) || stopOnClose)) {
          terminals.dispose(id);
        }
      } catch (e) {
        if (closingTabs.get(id) === closeToken) {
          closingTabs.delete(id);
          dispatch({ type: "RESTORE_TAB", id });
        }
        showToast(shortError(e));
      }
    },
    async stop(id) {
      try {
        await ipc.stopSession(id);
      } catch (e) {
        showToast(shortError(e));
      }
    },
    async deleteSession(id) {
      dispatch({ type: "REMOVE_SESSION", id });
      terminals.dispose(id);
      try {
        await ipc.deleteSession(id);
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
      const ids = stateRef.current.sessions.filter((s) => s.folderId === id).map((s) => s.id);
      dispatch({ type: "REMOVE_FOLDER", id });
      ids.forEach((sid) => terminals.dispose(sid));
      try {
        await ipc.removeFolder(id);
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
    toast(text) {
      showToast(text);
    },
  };
}

function shortError(e: unknown): string {
  const msg = String(e);
  // Errors are "CODE: message"; show the human half when present.
  const idx = msg.indexOf(": ");
  return idx > 0 ? msg.slice(idx + 2) : msg;
}
