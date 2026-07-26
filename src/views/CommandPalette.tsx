/** ⌘K command palette — fuzzy jump to any session. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Modal, StatusDot } from "../components/lib";
import { useAnchor } from "../app/store";
import { folderOf, toolName } from "../app/display";

export function CommandPalette() {
  const { state, actions } = useAnchor();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.paletteOpen) {
      setQuery("");
      inputRef.current?.focus();
    }
  }, [state.paletteOpen]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.sessions
      .map((s) => ({ s, folder: folderOf(s, state.folders) }))
      .filter(({ s, folder }) => {
        if (!q) return true;
        return `${s.title} ${folder?.name ?? ""} ${toolName(s.tool)}`.toLowerCase().includes(q);
      });
  }, [query, state.sessions, state.folders]);

  if (!state.paletteOpen) return null;

  return (
    <Modal onClose={() => actions.closePalette()} align="top" topOffset="12vh" width={560}>
      <div className="palette__head">
        <span style={{ color: "var(--text-3)", fontSize: 16 }}>⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a session or type to filter…"
          style={{ flex: 1, background: "transparent", border: "none", color: "#fff", fontSize: 15, outline: "none" }}
        />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-3)", padding: "3px 7px", borderRadius: 5, border: "1px solid var(--hairline)" }}>esc</span>
      </div>
      <div className="palette__list">
        {items.map(({ s, folder }) => (
          <button key={s.id} className="palette__item" onClick={() => { actions.selectSession(s.id); actions.closePalette(); }}>
            <Badge tool={s.tool} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
              <div className="palette__meta">{folder?.name ?? "—"} · {s.cliSessionId ?? "no id"}</div>
            </div>
            <StatusDot status={s.status} />
          </button>
        ))}
        {items.length === 0 && (
          <div style={{ padding: 16, color: "var(--text-3)", fontSize: 13 }}>No matching sessions.</div>
        )}
      </div>
    </Modal>
  );
}
