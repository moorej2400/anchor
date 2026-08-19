/** Top tab strip for open sessions + new-session button. */
import { Badge, StatusDot, Tab } from "../components/lib";
import { useAnchor } from "../app/store";
import { sessionById } from "../app/selectors";

export function TabStrip() {
  const { state, actions } = useAnchor();
  const tabs = state.openTabs
    .map((id) => sessionById(state.sessions, id))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <div className="tabstrip">
      <div className="tabstrip__lead">
        <button className="tabstrip__new a-plus" aria-label="New session" onClick={() => actions.openNewSession()}>
          +
        </button>
      </div>
      <div className="tabstrip__scroll">
        {tabs.map((s) => (
          <Tab key={s.id} active={s.id === state.activeId} onSelect={() => actions.selectSession(s.id)}>
            <Badge tool={s.tool} />
            <span className="a-tab__title">{s.title}</span>
            <StatusDot status={s.status} />
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
      </div>
    </div>
  );
}
