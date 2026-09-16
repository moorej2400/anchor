/** Top tab strip for open sessions + new-session button. */
import { useState, type DragEvent } from "react";
import { AttentionDot, Tab } from "../components/lib";
import { useAnchor } from "../app/store";
import { moveOrderedId, orderIds, sessionById, sessionDisplayTitle } from "../app/selectors";
import { activeWorkspace, workspaceIdForSession } from "../app/workspaces";

export function TabStrip() {
  const { state, actions } = useAnchor();
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const workspace = activeWorkspace(state.settings);
  const tabIds = orderIds(
    state.openTabs.filter((id) => workspaceIdForSession(state.settings, id) === workspace.id),
    workspace.tabOrder,
  );
  const tabs = tabIds
    .map((id) => sessionById(state.sessions, id))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const finishDrop = (targetId: string, after: boolean) => {
    if (!draggedTabId) return;
    const next = moveOrderedId(tabIds, draggedTabId, targetId, after);
    setDraggedTabId(null);
    setDropTarget(null);
    if (next !== tabIds) void actions.reorderTabs(next);
  };

  const dropSide = (event: DragEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX >= bounds.left + bounds.width / 2;
  };

  return (
    <div className="tabstrip">
      <div className="tabstrip__scroll">
        {tabs.map((s) => (
          <Tab
            key={s.id}
            active={s.id === state.activeId}
            draggable
            title="Drag tab to reorder"
            data-dragging={draggedTabId === s.id || undefined}
            data-drop={dropTarget?.id === s.id ? (dropTarget.after ? "after" : "before") : undefined}
            onDragStart={(event) => {
              setDraggedTabId(s.id);
              setDropTarget(null);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", s.id);
            }}
            onDragOver={(event) => {
              if (!draggedTabId || draggedTabId === s.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTarget({ id: s.id, after: dropSide(event) });
            }}
            onDrop={(event) => {
              event.preventDefault();
              finishDrop(s.id, dropSide(event));
            }}
            onDragEnd={() => {
              setDraggedTabId(null);
              setDropTarget(null);
            }}
            onSelect={() => actions.selectSession(s.id)}
          >
            <span className="a-tab__title">{sessionDisplayTitle(s, state.sessions)}</span>
            {state.unreadResponses[s.id] && <AttentionDot ready />}
            <button
              className="a-iconbtn"
              style={{ width: 16, height: 16, fontSize: 13 }}
              aria-label="Close tab"
              onClick={(e) => { e.stopPropagation(); void actions.closeTab(s.id); }}
            >
              ×
            </button>
          </Tab>
        ))}
        <button className="tabstrip__new a-plus" aria-label="New session" onClick={() => actions.openNewSession()}>
          +
        </button>
      </div>
    </div>
  );
}
