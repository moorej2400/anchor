# Terminal Switching and Close Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sidebar/tab selection show the correct terminal by the next paint and make tab closure immediately responsive while process shutdown completes safely in the background.

**Architecture:** Replace terminal DOM reparenting with a stable terminal deck: every open, live session owns one persistent slot, and selection only changes which slot is visible. Buffer PTY output even before a session has first been displayed. Treat `set_tab_open(false)` as the single close lifecycle command, run blocking Rust lifecycle work on Tauri's blocking pool, and coalesce terminal fitting to one animation-frame operation.

**Tech Stack:** React 19, TypeScript, xterm.js 6, Vitest, Testing Library, Tauri 2, Rust, portable-pty.

---

## Review findings

### 1. Terminal visibility is not bound atomically to active session state

`src/views/TerminalPane.tsx` reuses one React host and changes the imperative
xterm child later in `useEffect`. Its cleanup removes only resize listeners; it
does not detach the previous terminal. `TerminalManager.attach` then scans all
handles and removes wrappers only when their `parentElement` is exactly the
current host. React lifecycle, detached hosts, repeated switching, and real
xterm/WebGL nodes are absent from the regression test.

This permits `state.activeId`, active tab styling, and the visible xterm DOM to
disagree. The earlier live accessibility trace showing two terminal input nodes
with one active session is consistent with this ownership split.

### 2. Output for a never-displayed terminal is discarded

`TerminalManager.write` uses `this.handles.get(id)?.term.write(data)`. A handle
is created only by `attach`, so PTY output emitted before the user first views a
session is lost. This is especially damaging for auto-restored background tabs:
switching can reveal an empty or stale terminal even though the process is live.

### 3. Auto-restore starts before frontend event subscriptions are ready

The backend begins restoring sessions from `PageLoadEvent::Finished`.
`AnchorProvider` does not register `pty:output` and status listeners until after
`get_state`, `get_settings`, and all CLI version probes finish. Output and status
events emitted in that interval cannot be recovered by xterm.

### 4. A close request stops the same PTY twice

`closeTab` calls `set_tab_open(false)` and then calls `stop_session`. The Rust
implementation of `set_tab_open(false)` already invokes `stop_if_live` when
`stopOnClose` is enabled. The backend's operation mutex serializes these two
requests, so the second request waits behind work the first request already did.

### 5. Blocking lifecycle work runs through synchronous Tauri commands

`stop_session`, `set_tab_open`, `delete_session`, and `remove_folder` are
synchronous command handlers. PTY stop deliberately waits up to five seconds
for graceful termination, up to two seconds for a forced stop, and up to two
seconds for event completion. Running that wait in a synchronous command can
block the native UI thread and explains the roughly five-second macOS spinner.
The graceful timeout is valid; it must run off the UI thread.

### 6. Switching performs redundant forced layout

`TerminalManager.attach` calls `fit`, then `TerminalSurface.syncSize` calls
`fit` again, and `ResizeObserver` can immediately call it a third time.
`FitAddon.fit()` performs layout measurement. Doing it repeatedly during a
selection transition increases input-to-paint latency.

### 7. Current tests prove neither reported behavior

The only terminal regression directly calls `attach` twice on a `FakeElement`.
There is no test that clicks a sidebar row or tab, no assertion that the visible
terminal ID equals `activeId`, no pre-mount output test, no repeated-switch
test, and no close test asserting a single lifecycle request and an immediate
adjacent-tab render.

## Acceptance criteria

- A sidebar or tab click makes exactly one terminal visible, and its
  `data-terminal-session-id` equals the selected session ID by the next paint.
- Fifty alternating selections never show two terminal slots and never lose
  either session's buffer.
- PTY output received before first display appears when that session is selected.
- Closing a tab removes it and selects its neighbor without waiting for PTY
  shutdown or registry I/O.
- Closing with `stopOnClose=true` sends exactly one close lifecycle command and
  one PTY stop request.
- A synthetic PTY that consumes the full five-second graceful-stop window does
  not freeze the window; other tabs and Settings remain interactive.
- One terminal fit and at most one changed-dimensions `resize_pty` call occur per
  activation frame.
- Closed sessions release their xterm/WebGL handle after successful stop, unless
  the tab was reopened before shutdown completed.

## File map

- Modify `src/app/terminals.ts`: buffer unseen output, mount terminals into
  stable slots, cache dimensions, and expose handle disposal.
- Modify `src/views/TerminalPane.tsx`: render a stable terminal deck and switch
  visibility declaratively.
- Modify `src/styles/app.css`: terminal deck/slot visibility and pane layout.
- Modify `src/app/store.tsx`: subscribe before hydration, issue one close
  lifecycle request, and dispose only after successful closure.
- Modify `src/ipc/commands.ts`: expose the frontend-ready handshake.
- Modify `src/ipc/mock.ts`: implement the handshake in browser mock mode.
- Modify `src-tauri/src/commands.rs`: move blocking lifecycle operations to
  `spawn_blocking` and expose the frontend-ready handshake.
- Modify `src-tauri/src/lib.rs`: stop auto-restore from racing frontend listener
  registration.
- Modify `src-tauri/src/backend.rs`: trigger one-time auto-restore after the
  explicit frontend-ready handshake and count stop calls in tests.
- Modify `docs/SPEC.md`: document stable terminal slots, listener-before-restore
  ordering, and single-owner close semantics.
- Modify `src/app/terminals.test.ts`: manager-level buffer and mount tests.
- Create `src/views/TerminalPane.test.tsx`: visible-terminal integration tests.
- Create `src/app/store.test.tsx`: close orchestration and responsiveness tests.

### Task 1: Lock down terminal identity and pre-display buffering

**Files:**
- Modify: `src/app/terminals.test.ts`
- Modify: `src/app/terminals.ts`

- [ ] **Step 1: Replace the narrow attachment test with failing ownership and buffer tests**

Extend the xterm mock so each instance records writes, then add:

```ts
const terminalInstances: Array<{ writes: string[] }> = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    writes: string[] = [];

    constructor() {
      terminalInstances.push(this);
    }

    loadAddon() {}
    onData() {}
    open() {}
    write(data: string) {
      this.writes.push(data);
    }
    focus() {}
    dispose() {}
  },
}));

it("buffers output before a terminal is mounted", () => {
  const manager = new TerminalManager(() => {});

  manager.write("background-session", "output before first view");

  expect(manager.has("background-session")).toBe(true);
  expect(terminalInstances[0]?.writes).toEqual(["output before first view"]);
});

it("mounts exactly one terminal wrapper into each stable slot", () => {
  const manager = new TerminalManager(() => {});
  const firstSlot = new FakeElement();
  const secondSlot = new FakeElement();

  manager.mount("first-session", firstSlot as unknown as HTMLElement);
  manager.mount("second-session", secondSlot as unknown as HTMLElement);

  expect(firstSlot.children).toHaveLength(1);
  expect(secondSlot.children).toHaveLength(1);
  expect(firstSlot.firstElementChild).not.toBe(secondSlot.firstElementChild);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- --run src/app/terminals.test.ts
```

Expected: FAIL because `write` does not create a handle and `mount` does not
exist.

- [ ] **Step 3: Replace reparenting attachment with stable-slot mounting**

In `src/app/terminals.ts`, remove `attach` and add:

```ts
export interface TermHandle {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  lastCols: number | null;
  lastRows: number | null;
}

mount(id: string, parent: HTMLElement): boolean {
  const handle = this.ensure(id);
  if (handle.el.parentElement !== parent) {
    parent.replaceChildren(handle.el);
  }
  if (handle.opened) return false;

  handle.term.open(handle.el);
  handle.opened = true;
  try {
    handle.term.loadAddon(new WebglAddon());
  } catch {
    // Canvas/DOM rendering remains supported when WebGL is unavailable.
  }
  return true;
}

unmount(id: string, parent: HTMLElement): void {
  const handle = this.handles.get(id);
  if (handle?.el.parentElement === parent) handle.el.remove();
}

write(id: string, data: string): void {
  this.ensure(id).term.write(data);
}

fit(id: string): { cols: number; rows: number } | null {
  const handle = this.handles.get(id);
  if (!handle?.opened) return null;
  try {
    handle.fit.fit();
  } catch {
    return null;
  }

  const { cols, rows } = handle.term;
  if (handle.lastCols === cols && handle.lastRows === rows) return null;
  handle.lastCols = cols;
  handle.lastRows = rows;
  return { cols, rows };
}
```

Initialize `lastCols` and `lastRows` to `null` in `ensure`. Do not call `fit`
from `mount`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm test -- --run src/app/terminals.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the manager change**

```bash
git add src/app/terminals.ts src/app/terminals.test.ts
git commit -m "fix: preserve terminal identity before first display"
```

### Task 2: Render terminals as a stable deck

**Files:**
- Create: `src/views/TerminalPane.test.tsx`
- Modify: `src/views/TerminalPane.tsx`
- Modify: `src/styles/app.css`

- [ ] **Step 1: Write a failing visible-terminal integration test**

Export `TerminalDeck` with explicit inputs so it can be tested without booting
the whole application:

```tsx
interface TerminalDeckProps {
  sessions: Session[];
  activeId: string | null;
  terminals: TerminalManager;
}
```

In `src/views/TerminalPane.test.tsx`, create two running synthetic sessions,
render the deck, rerender it with the other active ID, and assert:

```tsx
it("shows only the selected session while preserving both mounted terminals", () => {
  const terminals = new TerminalManager(() => {});
  const sessions = [
    syntheticSession("session-a"),
    syntheticSession("session-b"),
  ];
  const { container, rerender } = render(
    <TerminalDeck sessions={sessions} activeId="session-a" terminals={terminals} />,
  );

  expect(container.querySelectorAll('[data-terminal-active="true"]')).toHaveLength(1);
  expect(
    container.querySelector('[data-terminal-active="true"]'),
  ).toHaveAttribute("data-terminal-session-id", "session-a");

  rerender(
    <TerminalDeck sessions={sessions} activeId="session-b" terminals={terminals} />,
  );

  expect(container.querySelectorAll("[data-terminal-session-id]")).toHaveLength(2);
  expect(container.querySelectorAll('[data-terminal-active="true"]')).toHaveLength(1);
  expect(
    container.querySelector('[data-terminal-active="true"]'),
  ).toHaveAttribute("data-terminal-session-id", "session-b");
});
```

Add a loop that rerenders alternating IDs fifty times and repeats the
single-visible-slot assertion.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --run src/views/TerminalPane.test.tsx
```

Expected: FAIL because `TerminalDeck` does not exist.

- [ ] **Step 3: Implement the stable terminal deck**

Keep every open live session mounted for the lifetime of its tab. Use
`useLayoutEffect` for mounting so the selected terminal is correct before paint,
and schedule fit/focus once per frame:

```tsx
export function TerminalDeck({
  sessions,
  activeId,
  terminals,
}: TerminalDeckProps) {
  return (
    <div className="terminal-deck">
      {sessions.map((session) => (
        <TerminalSlot
          key={session.id}
          session={session}
          active={session.id === activeId}
          terminals={terminals}
        />
      ))}
    </div>
  );
}

function TerminalSlot({
  session,
  active,
  terminals,
}: {
  session: Session;
  active: boolean;
  terminals: TerminalManager;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    terminals.mount(session.id, host);
    return () => terminals.unmount(session.id, host);
  }, [session.id, terminals]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const dims = terminals.fit(session.id);
        if (dims) {
          void ipc.resizePty(session.id, dims.cols, dims.rows).catch(() => {});
        }
        terminals.focus(session.id);
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, session.id, terminals]);

  return (
    <div
      ref={hostRef}
      className="terminal-slot"
      data-terminal-active={active ? "true" : "false"}
      data-terminal-session-id={session.id}
      aria-hidden={!active}
    />
  );
}
```

`TerminalPane` should always render live open tabs in the deck, even when the
active tab is stopped and displays a Resume card:

```tsx
export function TerminalPane({ active }: { active: Session | null }) {
  const { state, terminals } = useAnchor();
  const liveTabs = state.openTabs
    .map((id) => state.sessions.find((session) => session.id === id))
    .filter((session): session is Session => Boolean(session && isOn(session.status)));
  const activeLiveId = active && isOn(active.status) ? active.id : null;

  return (
    <div className="terminal-stage">
      <TerminalDeck sessions={liveTabs} activeId={activeLiveId} terminals={terminals} />
      {!active ? <EmptyState /> : !isOn(active.status) ? <ResumeCard session={active} /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Add stable-slot CSS**

Add:

```css
.terminal-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.terminal-deck {
  position: absolute;
  inset: 0;
}
.terminal-slot {
  position: absolute;
  inset: var(--sp-4) 18px;
  visibility: hidden;
  pointer-events: none;
}
.terminal-slot[data-terminal-active="true"] {
  visibility: visible;
  pointer-events: auto;
}
.terminal-slot .xterm {
  height: 100%;
}
```

Remove the superseded `.term-host` rules.

- [ ] **Step 5: Run the deck and manager tests**

Run:

```bash
npm test -- --run src/app/terminals.test.ts src/views/TerminalPane.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the terminal deck**

```bash
git add src/views/TerminalPane.tsx src/views/TerminalPane.test.tsx src/styles/app.css
git commit -m "fix: bind visible terminal to active session"
```

### Task 3: Remove the auto-restore event race

**Files:**
- Modify: `src/app/store.tsx`
- Modify: `src/ipc/commands.ts`
- Modify: `src/ipc/mock.ts`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/backend.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write a failing boot-order test**

In `src/app/store.test.tsx`, mock event subscriptions and IPC calls with an
ordered log:

```tsx
it("subscribes to PTY events before requesting state and starting restore", async () => {
  const order: string[] = [];
  onPtyOutputMock.mockImplementation(async () => {
    order.push("listen-output");
    return () => {};
  });
  onSessionStatusMock.mockImplementation(async () => {
    order.push("listen-status");
    return () => {};
  });
  getStateMock.mockImplementation(async () => {
    order.push("get-state");
    return { folders: [], sessions: [] };
  });
  frontendReadyMock.mockImplementation(async () => {
    order.push("frontend-ready");
  });

  render(
    <AnchorProvider>
      <div>ready</div>
    </AnchorProvider>,
  );
  await waitFor(() => expect(order).toContain("frontend-ready"));

  expect(order.indexOf("listen-output")).toBeLessThan(order.indexOf("get-state"));
  expect(order.indexOf("listen-status")).toBeLessThan(order.indexOf("get-state"));
  expect(order.indexOf("get-state")).toBeLessThan(order.indexOf("frontend-ready"));
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --run src/app/store.test.tsx
```

Expected: FAIL because state and CLI detection currently finish before
subscriptions are installed.

- [ ] **Step 3: Subscribe before hydration**

Reorder the provider boot effect:

```ts
const subs = await Promise.all([
  onPtyOutput((payload) => terminals.write(payload.sessionId, payload.data)),
  onSessionStatus((payload) =>
    dispatch({
      type: "SET_STATUS",
      id: payload.sessionId,
      status: payload.status,
    }),
  ),
  onSessionUpdated((session) =>
    dispatch({ type: "UPSERT_SESSION", session }),
  ),
  onAttentionCount((payload) =>
    dispatch({ type: "SET_WAITING", count: payload.waiting }),
  ),
]);
if (cancelled) {
  subs.forEach((unsubscribe) => unsubscribe());
  return;
}
unlisten = subs;

const [snapshot, settings, clis] = await Promise.all([
  ipc.getState(),
  ipc.getSettings(),
  ipc.detectClis(),
]);
```

- [ ] **Step 4: Start auto-restore from an explicit frontend-ready handshake**

Add the frontend and browser-mock command wrappers:

```ts
// src/ipc/commands.ts
frontendReady: () => call<void>("frontend_ready"),

// src/ipc/mock.ts
case "frontend_ready":
  return Promise.resolve(undefined as T);
```

After `dispatch({ type: "HYDRATE", ... })`, invoke:

```ts
await ipc.frontendReady();
```

React queues HYDRATE before any resulting status event, so restored `running`
events update hydrated sessions instead of being overwritten by a stale
pre-restore snapshot.

Rename `on_page_load_finished` to `on_frontend_ready` and expose:

```rust
#[tauri::command]
pub fn frontend_ready(backend: State<'_, Arc<Backend>>) {
    backend.inner().on_frontend_ready();
}
```

Remove `PageLoadGate`, `.on_page_load(...)`, and the setup-time gate from
`src-tauri/src/lib.rs`; register `commands::frontend_ready` in the handler list.
Keep the existing `AtomicBool` guard so reloads and repeated ready calls cannot
restore twice.

- [ ] **Step 5: Update backend ready-order tests**

Rename the backend test to
`auto_restore_runs_after_frontend_ready_once_and_surfaces_restore_errors` and
call `on_frontend_ready()` twice. Assert the atomic guard and one restore spawn.

- [ ] **Step 6: Run boot-order and backend tests**

Run:

```bash
npm test -- --run src/app/store.test.tsx
CARGO_TARGET_DIR=/private/tmp/anchor-terminal-plan cargo test auto_restore
```

Expected: PASS.

- [ ] **Step 7: Commit ready-order changes**

```bash
git add src/app/store.tsx src/app/store.test.tsx src/ipc/commands.ts src/ipc/mock.ts src-tauri/src/commands.rs src-tauri/src/backend.rs src-tauri/src/lib.rs
git commit -m "fix: subscribe before restoring terminal sessions"
```

### Task 4: Make close immediate and issue one lifecycle request

**Files:**
- Modify: `src/app/store.test.tsx`
- Modify: `src/app/store.tsx`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/backend.rs`

- [ ] **Step 1: Write a failing close orchestration test**

Use a deferred `setTabOpen` promise and assert that close updates the UI without
settling it:

```tsx
it("closes immediately and sends one backend-owned close request", async () => {
  const close = deferred<void>();
  setTabOpenMock.mockReturnValue(close.promise);
  stopSessionMock.mockResolvedValue(undefined);
  renderRunningSessionApp();

  fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));

  expect(screen.queryByRole("button", { name: "Close tab" })).not.toBeInTheDocument();
  expect(setTabOpenMock).toHaveBeenCalledTimes(1);
  expect(setTabOpenMock).toHaveBeenCalledWith("synthetic-session", false);
  expect(stopSessionMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  expect(screen.getByText("General")).toBeInTheDocument();
  close.resolve();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --run src/app/store.test.tsx
```

Expected: FAIL because `closeTab` also invokes `stopSession`.

- [ ] **Step 3: Give close lifecycle one owner**

Replace `closeTab` with:

```ts
const closingTabs = new Map<string, symbol>();

// At the start of selectSession:
closingTabs.delete(id);

async closeTab(id) {
  const session = stateRef.current.sessions.find((candidate) => candidate.id === id);
  const stopOnClose = stateRef.current.settings.stopOnClose;
  const closeToken = Symbol(id);
  closingTabs.set(id, closeToken);
  dispatch({ type: "CLOSE_TAB", id });

  try {
    await ipc.setTabOpen(id, false);
    if (
      closingTabs.get(id) === closeToken &&
      session &&
      (!isOn(session.status) || stopOnClose)
    ) {
      terminals.dispose(id);
    }
    if (closingTabs.get(id) === closeToken) closingTabs.delete(id);
  } catch (error) {
    if (closingTabs.get(id) === closeToken) {
      closingTabs.delete(id);
      dispatch({ type: "RESTORE_TAB", id });
    }
    showToast(shortError(error));
  }
}
```

Add a `RESTORE_TAB` reducer action that appends the ID without changing the
current active tab unless no tab is active:

```ts
case "RESTORE_TAB": {
  const openTabs = state.openTabs.includes(action.id)
    ? state.openTabs
    : [...state.openTabs, action.id];
  return {
    ...state,
    openTabs,
    activeId: state.activeId ?? action.id,
  };
}
```

Delete the explicit close-path `ipc.stopSession` call. Keep `stop(id)` for the
Status bar's explicit Stop button.

- [ ] **Step 4: Move blocking lifecycle commands off the Tauri UI thread**

Add this private helper in `src-tauri/src/commands.rs`:

```rust
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "BACKGROUND_TASK_FAILED: lifecycle operation did not complete".to_string())?
}
```

Convert lifecycle handlers that can wait for PTYs:

```rust
#[tauri::command]
pub async fn stop_session(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
) -> Result<(), String> {
    let backend = Arc::clone(backend.inner());
    run_blocking(move || backend.stop_session(&session_id)).await
}

#[tauri::command]
pub async fn set_tab_open(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
    open: bool,
) -> Result<(), String> {
    let backend = Arc::clone(backend.inner());
    run_blocking(move || backend.set_tab_open(&session_id, open)).await
}
```

Apply the same wrapper to `delete_session` and `remove_folder`, which can stop
one or more PTYs. Do not shorten `GRACEFUL_STOP_TIMEOUT`; responsiveness comes
from moving the wait off the UI thread.

- [ ] **Step 5: Count close-path stop calls in the backend regression**

Add `stop_calls: AtomicUsize` to `FakeRuntime`, increment it in `stop`, close a
running tab with `set_tab_open(false)`, and assert:

```rust
assert_eq!(runtime.stop_calls.load(Ordering::Acquire), 1);
assert!(!backend.session(&session.id).unwrap().was_open_in_tab);
```

- [ ] **Step 6: Run close and backend tests**

Run:

```bash
npm test -- --run src/app/store.test.tsx
CARGO_TARGET_DIR=/private/tmp/anchor-terminal-plan cargo test tab_close
CARGO_TARGET_DIR=/private/tmp/anchor-terminal-plan cargo test lifecycle_operations
```

Expected: PASS.

- [ ] **Step 7: Commit close responsiveness**

```bash
git add src/app/store.tsx src/app/store.test.tsx src-tauri/src/commands.rs src-tauri/src/backend.rs
git commit -m "fix: keep tab closure off the UI thread"
```

### Task 5: Remove avoidable switching work

**Files:**
- Modify: `src/views/TerminalPane.test.tsx`
- Modify: `src/views/Sidebar.tsx`
- Modify: `src/views/TerminalPane.tsx`

- [ ] **Step 1: Assert one resize per changed activation size**

Mock `requestAnimationFrame`, `ResizeObserver`, and `ipc.resizePty`. Activate a
slot, invoke the observer repeatedly in the same frame, flush the frame, and
assert one resize. Flush another frame without changing xterm dimensions and
assert the call count stays one.

- [ ] **Step 2: Run the test and verify it fails before coalescing**

Run:

```bash
npm test -- --run src/views/TerminalPane.test.tsx
```

Expected: FAIL if repeated observer callbacks schedule more than one fit/resize.

- [ ] **Step 3: Keep one pending animation frame per active slot**

Use the `cancelAnimationFrame(frame)`/`requestAnimationFrame` scheduling shown
in Task 2 and rely on `TerminalManager.fit`'s dimension cache before invoking
`resize_pty`.

- [ ] **Step 4: Memoize sidebar derived collections**

Replace render-time recomputation with:

```ts
const groups = useMemo(
  () => foldersWithSessions(state.folders, state.sessions, state.filter),
  [state.folders, state.sessions, state.filter],
);
const counts = useMemo(
  () => statusCounts(state.sessions),
  [state.sessions],
);
```

Import `useMemo`. This prevents tab selection alone from re-filtering and
re-sorting every session.

- [ ] **Step 5: Run focused frontend tests**

Run:

```bash
npm test -- --run src/app/terminals.test.ts src/views/TerminalPane.test.tsx src/app/store.test.tsx src/app/selectors.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit switching performance work**

```bash
git add src/views/TerminalPane.tsx src/views/TerminalPane.test.tsx src/views/Sidebar.tsx
git commit -m "perf: coalesce terminal activation layout"
```

### Task 6: Document invariants and perform full validation

**Files:**
- Modify: `docs/SPEC.md`
- Test: all frontend and Rust suites

- [x] **Step 1: Update the normative terminal invariant**

In SPEC §8, require:

```markdown
Each open ON session owns one stable xterm DOM slot for the tab's lifetime.
Changing `activeId` changes visibility only; it never reparents another
session's xterm root. Exactly one slot is visible, and PTY output received
before first display is buffered in that session's xterm instance.
```

- [x] **Step 2: Update boot and close ordering**

Document:

```markdown
Frontend event listeners are installed before the initial `get_state` request.
After hydration, the frontend sends `frontend_ready`, which triggers one-time
auto-restore. Restored PTY output and status therefore cannot race listener
registration or be overwritten by the pre-restore snapshot.

`set_tab_open(false)` is the sole close lifecycle command. When `stopOnClose`
is enabled, the backend stops the PTY and persists the closed-tab state; the
frontend must not also call `stop_session`. PTY waiting occurs on a blocking
worker and never on the native UI thread.
```

Add this row to SPEC §6.2:

```markdown
| `frontend_ready` | — | `void` | Called after event subscriptions and HYDRATE; starts guarded one-time auto-restore. |
```

- [x] **Step 3: Run complete automated validation**

Run:

```bash
npm run build
npm test
CARGO_TARGET_DIR=/private/tmp/anchor-terminal-plan cargo test
CARGO_TARGET_DIR=/private/tmp/anchor-terminal-plan cargo check
CARGO_TARGET_DIR=/private/tmp/anchor-terminal-plan cargo clippy --lib -- -D warnings
cargo fmt --check
git diff --check
```

Expected: all commands pass; the authenticated real-provider smoke remains
ignored unless explicitly enabled.

- [x] **Step 4: Run manual development E2E**

Start:

```bash
npm run tauri dev
```

Validate:

1. Open at least three live sessions and produce distinct visible markers.
2. Alternate sidebar rows and tabs fifty times; the selected marker must appear
   by the next paint and only one terminal input surface may be exposed.
3. Leave one session inactive while it produces output, then select it and
   confirm the complete buffered output is present.
4. Close a CLI that takes the graceful-stop path; immediately switch tabs and
   open Settings while shutdown continues.
5. Confirm no macOS spinner appears and the adjacent tab is visible immediately.
6. Reopen the closed saved session and confirm its exact provider ID still resumes.

Run automatically rather than by hand, against `VITE_IPC=mock` in a real
(visible) Chrome driven over CDP, so input is trusted, `requestAnimationFrame`
fires, and the xterm WebGL renderer actually draws. Results:

| # | Result |
| --- | --- |
| 1 | 5 live sessions, 5 distinct rendered frames |
| 2 | 50/50 alternations correct; each step asserted exactly one active slot, one non-`visibility:hidden` slot, and exactly one focusable `xterm-helper-textarea` |
| 3 | Banner streamed while the session was hidden; on selection both its first and last line were present |
| 4 | `confirmClose` prompts first; the tab is removed 41.1 ms after the confirmation is accepted, and Settings opens straight afterwards while shutdown is still pending |
| 5 | `set_tab_open` and `stop_session` are `spawn_blocking` (`commands.rs`), so PTY waiting never occupies the UI thread. The literal absence of a beachball is only observable in the native window |
| 6 | Reopened session offers its exact saved provider ID (`e7f3-5540-2c19`). Also covered by `src-tauri/tests/adapters.rs`, which asserts resume spawns with the saved ID and fails without one |

Hidden slots use `visibility: hidden`, which makes their descendants
unfocusable; calling `.focus()` on a hidden terminal's textarea leaves
`document.activeElement` on `<body>`. That is what enforces the single exposed
input surface.

- [x] **Step 5: Record performance evidence**

Capture input-to-visible-terminal and input-to-tab-removal marks during the
manual run. Both UI transitions must complete within 100 ms, with no main-thread
long task over 50 ms. Backend PTY shutdown may continue for its documented
grace period without affecting those UI measurements.

Measured over the 50 alternations above, from trusted CDP input to the second
`requestAnimationFrame` after it (so each figure carries ~33 ms of inherent
frame latency and is therefore conservative):

| Metric | Value | Budget |
| --- | --- | --- |
| Input to visible terminal, p50 | 25.8 ms | < 100 ms |
| Input to visible terminal, p95 | 36.8 ms | < 100 ms |
| Input to visible terminal, max | 48.6 ms | < 100 ms |
| Samples over 100 ms | 0 / 50 | 0 |
| Input to tab removal (after confirming) | 47.7 ms | < 100 ms |
| Main-thread long tasks > 50 ms | 0 | 0 |

Tab removal is timed from a capture-phase `click` listener inside the page, not
from a timestamp taken in the driver: measuring across the driver's two CDP
dispatch round trips inflated the same interval to 150 ms.

Event Timing (`PerformanceObserver`, `type: "event"`) recorded a worst-case
`pointerup`/`click` duration of 88 ms across 98 entries, also within budget.

- [x] **Step 6: Commit documentation**

```bash
git add docs/SPEC.md
git commit -m "docs: define terminal switching and close latency invariants"
```

## Plan self-review

- Spec coverage: sidebar selection, tab selection, pre-display output,
  auto-restore ordering, close lifecycle, graceful shutdown, disposal, and
  measurable latency all have explicit tasks and tests.
- Contract consistency: the plan adds only the zero-argument
  `frontend_ready → void` handshake and updates SPEC §6 in the same change.
  `set_tab_open(false)` becomes the documented single owner of the existing
  close behavior.
- Type consistency: `TerminalManager.mount`, `unmount`, `write`, `fit`, and
  `dispose` are used consistently by the manager tests and terminal deck.
- Scope: the plan does not alter provider adapters, session-ID semantics,
  terminal content, or the five-second graceful-stop policy.
- Placeholder scan: the plan contains no deferred implementation decisions.
