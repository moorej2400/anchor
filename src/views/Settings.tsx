/** Settings view — General, Persistence & Backup, Appearance, Keyboard Shortcuts. */
import {
  ACCENT_SWATCHES,
  Button,
  RadioGroup,
  Slider,
  TextInput,
  Toggle,
} from "../components/lib";
import { ipc } from "../ipc/commands";
import { useAnchor } from "../app/store";
import { statusCounts } from "../app/selectors";
import type { SettingsSection } from "../app/store";

const NAV: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "persistence", label: "Persistence & Backup" },
  { id: "appearance", label: "Appearance" },
  { id: "shortcuts", label: "Keyboard Shortcuts" },
];

const SHORTCUTS: { d: string; k: string }[] = [
  { d: "Command palette", k: "⌘ K" },
  { d: "Open settings", k: "⌘ ," },
  { d: "Close current tab", k: "⌘ W" },
  { d: "Next / previous tab", k: "⌃ ⇥" },
  { d: "Resume session under cursor", k: "⌘ ↩" },
  { d: "New generic terminal", k: "⌘ T" },
  { d: "Focus session filter", k: "⌘ F" },
];

export function Settings() {
  const { state, actions } = useAnchor();
  const { settings } = state;
  const section = state.settingsSection;

  return (
    <div className="settings">
      <nav className="settings__nav">
        <div className="settings__navlabel">Settings</div>
        {NAV.map((n) => (
          <button key={n.id} className="settings__navbtn" data-on={section === n.id} onClick={() => actions.setSettingsSection(n.id)}>
            {section === n.id && <span className="navbg" />}
            {section === n.id && <span className="navbar" />}
            <span className="settings__navtext">{n.label}</span>
          </button>
        ))}
        <button className="settings__navbtn" style={{ marginTop: 14, border: "1px solid var(--hairline)" }} onClick={() => actions.closeSettings()}>
          <span className="settings__navtext" style={{ color: "var(--text-2)" }}>← Back to sessions</span>
        </button>
      </nav>

      <div className="settings__body">
        <div className="settings__inner">
          {section === "general" && <General />}
          {section === "persistence" && <Persistence />}
          {section === "appearance" && <Appearance />}
          {section === "shortcuts" && <Shortcuts />}
        </div>
      </div>
    </div>
  );

  function General() {
    return (
      <div>
        <div className="settings__h">General</div>
        <div className="settings__sub">Shell, environment and startup behaviour.</div>

        <div className="settings__field">
          <div className="settings__fieldlabel">Default shell</div>
          <TextInput variant="mono" value={settings.shell} onChange={(e) => void actions.updateSettings({ shell: e.target.value })} />
        </div>

        <div className="settings__field">
          <div className="settings__fieldlabel" style={{ marginBottom: 4 }}>Projects directory</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
            Where “Create a new project” puts new folders. Default:{" "}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-2)" }}>~/Documents/Anchor/Projects</span>
          </div>
          <TextInput
            variant="mono"
            value={settings.projectsDir}
            onChange={(e) => void actions.updateSettings({ projectsDir: e.target.value })}
          />
        </div>

        <div className="settings__field">
          <div className="settings__fieldlabel">Environment variables</div>
          <div className="env-table">
            {settings.envVars.length === 0 && (
              <div className="env-row"><span className="v">No variables set.</span></div>
            )}
            {settings.envVars.map((ev, i) => (
              <div className="env-row" key={`${ev.key}-${i}`}>
                <span className="k">{ev.key}</span>
                <span className="eq">=</span>
                {/* Values are masked in the UI — they may hold secrets. */}
                <span className="v">••••••••</span>
                <span style={{ flex: 1 }} />
                <span
                  style={{ color: "var(--text-3)", cursor: "pointer" }}
                  onClick={() => void actions.updateSettings({ envVars: settings.envVars.filter((_, j) => j !== i) })}
                >
                  ✕
                </span>
              </div>
            ))}
          </div>
          <button
            className="a-btn a-btn--ghost"
            style={{ marginTop: 8, border: "1px dashed rgba(255,255,255,.16)", color: "var(--text-2)", fontSize: 12 }}
            onClick={() => {
              const key = window.prompt("Variable name")?.trim();
              if (!key) return;
              const value = window.prompt(`Value for ${key}`) ?? "";
              void actions.updateSettings({ envVars: [...settings.envVars, { key, value }] });
            }}
          >
            + Add variable
          </button>
        </div>

        <ToggleRow
          title="Auto-restore sessions on launch"
          desc="Reopen tabs and revive saved session IDs automatically."
          on={settings.autoRestore}
          onChange={(v) => void actions.updateSettings({ autoRestore: v })}
        />
        <ToggleRow
          title="Confirm before closing a running session"
          desc="Prevents accidentally killing an active AI run."
          on={settings.confirmClose}
          onChange={(v) => void actions.updateSettings({ confirmClose: v })}
        />
        <ToggleRow
          title="Stop session when its tab is closed"
          desc="When on, closing a tab stops the process and hides the manual Stop button."
          on={settings.stopOnClose}
          onChange={(v) => void actions.updateSettings({ stopOnClose: v })}
        />
      </div>
    );
  }

  function Persistence() {
    const persisted = statusCounts(state.sessions).stopped;
    return (
      <div>
        <div className="settings__h">Persistence &amp; Backup</div>
        <div className="settings__sub">Where session IDs, scrollback and metadata are stored between restarts.</div>

        <div className="callout">
          <span style={{ color: "var(--acc)", fontWeight: 600 }}>{persisted} sessions</span> are currently persisted and can be resumed after a reboot — the core promise of Anchor.
        </div>

        <div className="settings__field">
          <div className="settings__fieldlabel">Backup location</div>
          <div style={{ display: "flex", gap: 8 }}>
            <TextInput variant="mono" value={settings.backupPath} onChange={(e) => void actions.updateSettings({ backupPath: e.target.value })} />
            <Button variant="subtle" style={{ padding: "0 16px" }} onClick={() => { const p = window.prompt("Backup folder path", settings.backupPath); if (p) void actions.updateSettings({ backupPath: p }); }}>Browse…</Button>
          </div>
        </div>

        <ToggleRow
          title="Save & restore terminal scrollback"
          desc="Generic terminals reopen with their full history intact."
          on={settings.restoreScrollback}
          onChange={(v) => void actions.updateSettings({ restoreScrollback: v })}
        />

        <div style={{ padding: "16px 0", borderTop: "1px solid var(--hairline-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div className="settings__fieldlabel" style={{ marginBottom: 0 }}>Scrollback retention</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--acc)" }}>{settings.retentionDays} days</div>
          </div>
          <Slider value={settings.retentionDays} min={1} max={90} onChange={(v) => void actions.updateSettings({ retentionDays: v })} aria-label="Scrollback retention days" />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <Button variant="subtle" onClick={() => { const p = window.prompt("Export sessions to path"); if (p) void ipc.exportSessions(p).then(() => actions.toast("Sessions exported")).catch((e) => actions.toast(String(e))); }}>Export sessions…</Button>
          <Button variant="subtle" onClick={() => { const p = window.prompt("Import sessions from path"); if (p) void ipc.importSessions(p).then(() => actions.toast("Sessions imported — reopen to refresh")).catch((e) => actions.toast(String(e))); }}>Import…</Button>
        </div>
      </div>
    );
  }

  function Appearance() {
    return (
      <div>
        <div className="settings__h">Appearance</div>
        <div className="settings__sub">Theme, accent and terminal typography. Anchor is dark-only.</div>

        <div className="settings__field">
          <div className="settings__fieldlabel">Theme</div>
          <RadioGroup
            value={settings.theme}
            onChange={(v) => void actions.updateSettings({ theme: v as typeof settings.theme })}
            options={[
              { value: "graphite", label: "Graphite" },
              { value: "obsidian", label: "Obsidian" },
              { value: "nebula", label: "Nebula" },
            ]}
          />
        </div>

        <div className="settings__field">
          <div className="settings__fieldlabel">Accent colour</div>
          <div style={{ display: "flex", gap: 11 }}>
            {ACCENT_SWATCHES.map((hex) => (
              <button
                key={hex}
                title={hex}
                onClick={() => void actions.updateSettings({ accent: hex })}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  cursor: "pointer",
                  background: hex,
                  border: settings.accent === hex ? "2px solid #fff" : "2px solid rgba(255,255,255,.15)",
                  boxShadow: `0 3px 10px ${hex}66`,
                }}
              />
            ))}
          </div>
        </div>

        <div className="settings__field">
          <div className="settings__fieldlabel">Density</div>
          <RadioGroup
            value={settings.density}
            onChange={(v) => void actions.updateSettings({ density: v as typeof settings.density })}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </div>

        <div style={{ padding: "16px 0", borderTop: "1px solid var(--hairline-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div className="settings__fieldlabel" style={{ marginBottom: 0 }}>Terminal font size</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--acc)" }}>{settings.fontSize}px</div>
          </div>
          <Slider value={settings.fontSize} min={11} max={18} onChange={(v) => void actions.updateSettings({ fontSize: v })} aria-label="Terminal font size" />
          <div className="font-preview">
            <span style={{ color: "var(--acc)" }}>›</span> the quick brown fox jumps — 0123456789
          </div>
        </div>
      </div>
    );
  }

  function Shortcuts() {
    return (
      <div>
        <div className="settings__h">Keyboard Shortcuts</div>
        <div className="settings__sub">Global bindings across the app.</div>
        <div className="shortcut-table">
          {SHORTCUTS.map((s) => (
            <div className="shortcut-row" key={s.d}>
              <span style={{ fontSize: 13, color: "var(--text-1)" }}>{s.d}</span>
              <span className="key">{s.k}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
}

function ToggleRow({ title, desc, on, onChange }: { title: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="settings__rowline">
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div className="desc">{desc}</div>
      </div>
      <Toggle on={on} onChange={onChange} aria-label={title} />
    </div>
  );
}
