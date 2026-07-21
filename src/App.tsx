/**
 * Phase 1 placeholder. Phase 3 replaces this with the full UI built to the
 * authoritative mock at docs/Anchor.dc.html (see docs/SPEC.md §8).
 */
import { useEffect, useState } from "react";
import { ipc } from "./ipc/commands";
import type { AppState } from "./ipc/types";
import "./App.css";

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc.getState().then(setState).catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="scaffold">
      <div className="scaffold-mark" />
      <h1>Anchor</h1>
      <p>Phase 1 scaffold — see docs/SPEC.md for the build plan.</p>
      <p className="scaffold-status">
        {error
          ? `IPC: ${error}`
          : state
            ? `IPC OK — ${state.folders.length} folders, ${state.sessions.length} sessions`
            : "Connecting to core…"}
      </p>
    </main>
  );
}

export default App;
