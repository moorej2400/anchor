import { useState } from "react";
import { Button, RadioGroup, Slider, TextInput, Toggle } from "../components/lib";
import { ipc } from "../ipc/commands";
import type {
  HarnessDefinition,
  ResponseReadDelayMs,
  TerminalTheme,
} from "../ipc/types";
import { useAnchor, type SettingsSection } from "../app/store";
import { statusCounts } from "../app/selectors";
import packageJson from "../../package.json";
import { Icon, type IconName } from "../components/Icon";

const NAV: { id: SettingsSection; icon: IconName; label: string }[] = [
  { id: "general", icon: "settings", label: "General" },
  { id: "appearance", icon: "palette", label: "Appearance" },
  { id: "notifications", icon: "bell", label: "Notifications" },
  { id: "terminal", icon: "terminal", label: "Terminal" },
  { id: "harnesses", icon: "wrench", label: "Harnesses" },
  { id: "persistence", icon: "archive", label: "Persistence & backup" },
  { id: "shortcuts", icon: "keyboard", label: "Keyboard shortcuts" },
  { id: "about", icon: "info", label: "About" },
];

const SHORTCUTS = [
  ["Command palette", "⌘ K"],
  ["Open settings", "⌘ ,"],
  ["Close current tab", "⌘ W"],
  ["Next / previous tab", "⌃ ⇥"],
  ["Resume selected session", "⌘ ↩"],
  ["New generic terminal", "⌘ T"],
  ["Focus session search", "⌘ F"],
] as const;

const TERMINAL_COLORS: { key: keyof TerminalTheme; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Foreground" },
  { key: "cursor", label: "Cursor" },
  { key: "selectionBackground", label: "Selection" },
  { key: "black", label: "Black" },
  { key: "red", label: "Red" },
  { key: "green", label: "Green" },
  { key: "yellow", label: "Yellow" },
  { key: "blue", label: "Blue" },
  { key: "magenta", label: "Magenta" },
  { key: "cyan", label: "Cyan" },
  { key: "white", label: "White" },
  { key: "brightBlack", label: "Bright black" },
  { key: "brightRed", label: "Bright red" },
  { key: "brightGreen", label: "Bright green" },
  { key: "brightYellow", label: "Bright yellow" },
  { key: "brightBlue", label: "Bright blue" },
  { key: "brightMagenta", label: "Bright magenta" },
  { key: "brightCyan", label: "Bright cyan" },
  { key: "brightWhite", label: "Bright white" },
];

const ACCENTS = ["#88a99d", "#769ec2", "#9a91bd", "#bd847f", "#b39b67", "#7fa887"];

export function SettingsPage() {
  const { state, actions } = useAnchor();
  const { settings } = state;
  const section = state.settingsSection;
  const [harnessDraft, setHarnessDraft] = useState<HarnessDefinition | null>(null);

  return (
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Settings sections">
        <h2>Settings</h2>
        {NAV.map((item) => (
          <button
            key={item.id}
            data-active={section === item.id || undefined}
            onClick={() => actions.setSettingsSection(item.id)}
          >
            <span aria-hidden="true"><Icon name={item.icon} size={15} /></span>
            <span>{item.label}</span>
          </button>
        ))}
        <div className="settings-nav__spacer" />
        <button onClick={() => actions.closeSettings()}><span><Icon name="arrow-left" size={15} /></span><span>Back to sessions</span></button>
        <div className="settings-nav__version">Anchor v{packageJson.version}</div>
      </nav>
      <div className="settings-main">
        <div className="settings-content">
          {section === "general" && <General />}
          {section === "appearance" && <Appearance />}
          {section === "notifications" && <Notifications />}
          {section === "terminal" && <Terminal />}
          {section === "harnesses" && <Harnesses />}
          {section === "persistence" && <Persistence />}
          {section === "shortcuts" && <Shortcuts />}
          {section === "about" && <About />}
        </div>
      </div>
      {harnessDraft && (
        <HarnessEditor
          harness={harnessDraft}
          onChange={setHarnessDraft}
          onClose={() => setHarnessDraft(null)}
          onSave={() => {
            void actions.saveHarness(harnessDraft);
            setHarnessDraft(null);
          }}
        />
      )}
    </div>
  );

  function Heading({ title, children }: { title: string; children: string }) {
    return <header className="settings-heading"><div><h1>{title}</h1><p>{children}</p></div></header>;
  }

  function General() {
    return (
      <>
        <Heading title="General">Startup, projects, workspaces, and process behavior.</Heading>
        <SettingsGroup title="Launch">
          <SettingRow title="Default shell" help="Used for generic terminal sessions.">
            <TextInput variant="mono" value={settings.shell} onChange={(event) => void actions.updateSettings({ shell: event.target.value })} />
          </SettingRow>
          <SettingRow title="Projects directory" help="New projects are created inside this directory.">
            <TextInput variant="mono" value={settings.projectsDir} onChange={(event) => void actions.updateSettings({ projectsDir: event.target.value })} />
          </SettingRow>
          <ToggleSetting title="Restore open tabs on launch" help="Reopen saved tabs and resume their sessions after Anchor starts." on={settings.autoRestore} onChange={(autoRestore) => void actions.updateSettings({ autoRestore })} />
          <ToggleSetting title="Confirm before interrupting an AI response" help="Idle provider processes close without a warning." on={settings.confirmClose} onChange={(confirmClose) => void actions.updateSettings({ confirmClose })} />
          <ToggleSetting title="Stop session when its tab closes" help="The saved chat remains available in the sidebar." on={settings.stopOnClose} onChange={(stopOnClose) => void actions.updateSettings({ stopOnClose })} />
        </SettingsGroup>
        <SettingsGroup title="Workspaces">
          <ToggleSetting title="Keep workspace rail open" help="Leave the workspace list visible after switching context." on={settings.workspacePaneKeepOpen} onChange={(workspacePaneKeepOpen) => void actions.updateSettings({ workspacePaneKeepOpen })} />
        </SettingsGroup>
        <SettingsGroup title="Environment variables">
          <div className="settings-env">
            {settings.envVars.length === 0 && <p>No environment variables configured.</p>}
            {settings.envVars.map((variable, index) => (
              <div key={`${variable.key}:${index}`}><code>{variable.key}</code><span>••••••••</span><button onClick={() => void actions.updateSettings({ envVars: settings.envVars.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button></div>
            ))}
            <button className="settings-inline-action" onClick={() => {
              const key = window.prompt("Variable name")?.trim();
              if (!key) return;
              const value = window.prompt(`Value for ${key}`) ?? "";
              void actions.updateSettings({ envVars: [...settings.envVars, { key, value }] });
            }}><Icon name="plus" size={13} /> Add variable</button>
          </div>
        </SettingsGroup>
      </>
    );
  }

  function Appearance() {
    return (
      <>
        <Heading title="Appearance">A compact, flat dark interface with adjustable density and accent.</Heading>
        <SettingsGroup title="Interface">
          <SettingRow title="Theme" help="All themes remain dark and avoid decorative gradients.">
            <RadioGroup value={settings.theme} onChange={(theme) => void actions.updateSettings({ theme: theme as typeof settings.theme })} options={[
              { value: "graphite", label: "Graphite" },
              { value: "obsidian", label: "Obsidian" },
              { value: "nebula", label: "Carbon steel" },
            ]} />
          </SettingRow>
          <SettingRow title="Accent color" help="Used for selected tabs and controls.">
            <div className="settings-swatches">{ACCENTS.map((color) => <button key={color} aria-label={color} data-active={settings.accent === color || undefined} style={{ background: color }} onClick={() => void actions.updateSettings({ accent: color })} />)}</div>
          </SettingRow>
          <SettingRow title="Density" help="Compact fits more chats and workspaces on screen.">
            <RadioGroup value={settings.density} onChange={(density) => void actions.updateSettings({ density: density as typeof settings.density })} options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]} />
          </SettingRow>
        </SettingsGroup>
      </>
    );
  }

  function Notifications() {
    return (
      <>
        <Heading title="Notifications">Control when Anchor marks completed work as needing your attention.</Heading>
        <SettingsGroup title="Attention">
          <ToggleSetting title="Notify when a session needs attention" help="Send an operating-system notification after an AI finishes while another tab is focused." on={settings.notifyOnWaiting} onChange={(notifyOnWaiting) => void actions.updateSettings({ notifyOnWaiting })} />
          <SettingRow title="Mark a response as read after" help="A blue dot clears only after the tab stays selected for this long.">
            <RadioGroup value={String(settings.responseReadDelayMs)} onChange={(value) => void actions.updateSettings({ responseReadDelayMs: Number(value) as ResponseReadDelayMs })} options={[
              { value: "0", label: "Instant" },
              { value: "1000", label: "1 second" },
              { value: "2500", label: "2.5 seconds" },
              { value: "5000", label: "5 seconds" },
            ]} />
          </SettingRow>
        </SettingsGroup>
      </>
    );
  }

  function Terminal() {
    const updateColor = (key: keyof TerminalTheme, value: string) => {
      void actions.updateSettings({ terminalTheme: { ...settings.terminalTheme, [key]: value } });
    };
    return (
      <>
        <Heading title="Terminal">Typography and the full ANSI color palette used by real PTY sessions.</Heading>
        <SettingsGroup title="Typography">
          <SettingRow title="Font size" help="Changes every live terminal and re-fits its PTY grid.">
            <div className="settings-range"><Slider min={11} max={18} value={settings.fontSize} onChange={(fontSize) => void actions.updateSettings({ fontSize })} /><code>{settings.fontSize}px</code></div>
          </SettingRow>
        </SettingsGroup>
        <SettingsGroup title="Color palette">
          <div className="terminal-color-grid">
            {TERMINAL_COLORS.map(({ key, label }) => (
              <label key={key}><span>{label}</span><input type="color" value={settings.terminalTheme[key]} onChange={(event) => updateColor(key, event.target.value)} /><code>{settings.terminalTheme[key]}</code></label>
            ))}
          </div>
          <div className="terminal-preview" style={{ background: settings.terminalTheme.background, color: settings.terminalTheme.foreground }}>
            <div style={{ color: settings.terminalTheme.cyan }}>Anchor terminal · ANSI preview</div>
            <div><span style={{ color: settings.terminalTheme.green }}>success</span> <span style={{ color: settings.terminalTheme.yellow }}>warning</span> <span style={{ color: settings.terminalTheme.red }}>error</span></div>
            <div style={{ color: settings.terminalTheme.magenta }}>› user-defined harness ready</div>
          </div>
        </SettingsGroup>
      </>
    );
  }

  function Harnesses() {
    const builtIns = ["Claude Code", "Codex", "Copilot", "opencode", "Generic terminal"];
    return (
      <>
        <Heading title="Harnesses">Add terminal tools without changing Anchor source code.</Heading>
        <SettingsGroup title="Built in">
          {builtIns.map((name) => <div className="harness-row" key={name}><strong>{name}</strong><code>Managed by Anchor</code><span className="harness-pill">Built in</span></div>)}
        </SettingsGroup>
        <SettingsGroup title="Custom">
          {settings.customHarnesses.map((harness) => (
            <div className="harness-row" key={harness.id}>
              <div><strong>{harness.name}</strong><small>{harness.kind} · {harness.sessionIdStrategy}</small></div>
              <code>{harness.executable}</code>
              <div className="harness-row__actions">
                <button onClick={() => setHarnessDraft({ ...harness, launchArgs: [...harness.launchArgs], resumeArgs: [...harness.resumeArgs] })}>Edit</button>
                <button onClick={() => void actions.removeHarness(harness.id)}>Remove</button>
              </div>
            </div>
          ))}
          {settings.customHarnesses.length === 0 && <div className="settings-empty">No custom harnesses yet.</div>}
          <button className="settings-inline-action" onClick={() => setHarnessDraft(newHarness())}><Icon name="plus" size={13} /> Add custom harness</button>
        </SettingsGroup>
        <p className="settings-note">Arguments are stored as individual values and passed directly to the executable. Supported placeholders: <code>{"{projectPath}"}</code>, <code>{"{sessionId}"}</code>, and <code>{"{dataDirectory}"}</code>.</p>
      </>
    );
  }

  function Persistence() {
    const persisted = statusCounts(state.sessions).stopped;
    return (
      <>
        <Heading title="Persistence & backup">Session identity, scrollback, and recovery storage.</Heading>
        <div className="settings-callout"><strong>{persisted} sessions</strong> are persisted and can be resumed after a restart.</div>
        <SettingsGroup title="Storage">
          <SettingRow title="Backup location" help="Registry and terminal scrollback are kept here.">
            <TextInput variant="mono" value={settings.backupPath} onChange={(event) => void actions.updateSettings({ backupPath: event.target.value })} />
          </SettingRow>
          <ToggleSetting title="Restore terminal scrollback" help="Generic terminals reopen with their saved output." on={settings.restoreScrollback} onChange={(restoreScrollback) => void actions.updateSettings({ restoreScrollback })} />
          <SettingRow title="Scrollback retention" help="Expired scrollback is pruned without deleting session identities.">
            <div className="settings-range"><Slider min={1} max={90} value={settings.retentionDays} onChange={(retentionDays) => void actions.updateSettings({ retentionDays })} /><code>{settings.retentionDays} days</code></div>
          </SettingRow>
        </SettingsGroup>
        <div className="settings-button-row">
          <Button variant="subtle" onClick={() => { const path = window.prompt("Export sessions to path"); if (path) void ipc.exportSessions(path).then(() => actions.toast("Sessions exported")).catch((error) => actions.toast(String(error))); }}>Export sessions…</Button>
          <Button variant="subtle" onClick={() => { const path = window.prompt("Import sessions from path"); if (path) void ipc.importSessions(path).then(() => actions.toast("Sessions imported — restart Anchor to reconcile tabs")).catch((error) => actions.toast(String(error))); }}>Import sessions…</Button>
        </div>
      </>
    );
  }

  function Shortcuts() {
    return (
      <>
        <Heading title="Keyboard shortcuts">Fast navigation across chats, workspaces, and settings.</Heading>
        <SettingsGroup title="Global">
          <div className="shortcut-list">{SHORTCUTS.map(([description, keys]) => <div key={description}><span>{description}</span><kbd>{keys}</kbd></div>)}</div>
        </SettingsGroup>
      </>
    );
  }

  function About() {
    return (
      <>
        <Heading title="About">Build information for the installed Anchor application.</Heading>
        <SettingsGroup title="Application">
          <div className="about-card"><div className="about-card__mark">⚓</div><div><strong>Anchor</strong><small>Version {packageJson.version}</small></div></div>
          <div className="setting-row"><div className="setting-copy"><strong>Runtime</strong><small>Tauri desktop application</small></div><code>v{packageJson.version}</code></div>
        </SettingsGroup>
      </>
    );
  }
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-group"><h3>{title}</h3><div className="settings-card">{children}</div></section>;
}

function SettingRow({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return <div className="setting-row"><div className="setting-copy"><strong>{title}</strong><small>{help}</small></div><div className="setting-control">{children}</div></div>;
}

function ToggleSetting({ title, help, on, onChange }: { title: string; help: string; on: boolean; onChange: (value: boolean) => void }) {
  return <SettingRow title={title} help={help}><Toggle on={on} onChange={onChange} aria-label={title} /></SettingRow>;
}

function newHarness(): HarnessDefinition {
  return {
    id: crypto.randomUUID(),
    name: "",
    executable: "",
    launchArgs: [],
    resumeArgs: [],
    sessionIdStrategy: "manual",
    workingDirectory: "project",
    dataDirectory: "",
    kind: "ai",
    enabled: true,
  };
}

function HarnessEditor(props: {
  harness: HarnessDefinition;
  onChange: (harness: HarnessDefinition) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { harness, onChange, onClose, onSave } = props;
  const update = <K extends keyof HarnessDefinition>(key: K, value: HarnessDefinition[K]) => onChange({ ...harness, [key]: value });
  return (
    <div className="settings-editor-scrim" onClick={onClose}>
      <div className="settings-editor" onClick={(event) => event.stopPropagation()}>
        <header><div><h2>{harness.name || "Custom harness"}</h2><p>Define an executable and typed argument templates.</p></div><button onClick={onClose} aria-label="Close"><Icon name="close" size={17} /></button></header>
        <div className="settings-editor__body">
          <label>Name<TextInput value={harness.name} onChange={(event) => update("name", event.target.value)} placeholder="Hermes" /></label>
          <label>Executable<TextInput variant="mono" value={harness.executable} onChange={(event) => update("executable", event.target.value)} placeholder="hermes" /></label>
          <div className="settings-editor__columns">
            <label>Kind<select value={harness.kind} onChange={(event) => update("kind", event.target.value as HarnessDefinition["kind"])}><option value="ai">AI harness</option><option value="terminal">Terminal tool</option></select></label>
            <label>Session ID strategy<select value={harness.sessionIdStrategy} onChange={(event) => update("sessionIdStrategy", event.target.value as HarnessDefinition["sessionIdStrategy"])}><option value="manual">Attach manually</option><option value="preassigned">Preassign UUID</option><option value="none">No session ID</option></select></label>
          </div>
          <label>Launch arguments <small>One argument per line</small><textarea value={harness.launchArgs.join("\n")} onChange={(event) => update("launchArgs", splitArgs(event.target.value))} placeholder={"--cwd\n{projectPath}"} /></label>
          <label>Resume arguments <small>One argument per line</small><textarea value={harness.resumeArgs.join("\n")} onChange={(event) => update("resumeArgs", splitArgs(event.target.value))} placeholder={"--resume\n{sessionId}"} /></label>
          <label>Dedicated data directory <small>Optional</small><TextInput variant="mono" value={harness.dataDirectory} onChange={(event) => update("dataDirectory", event.target.value)} placeholder="~/.my-harness/anchor" /></label>
          <div className="settings-editor__enabled"><div><strong>Enabled</strong><small>Show this harness when starting a new session.</small></div><Toggle on={harness.enabled} onChange={(enabled) => update("enabled", enabled)} /></div>
        </div>
        <footer><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!harness.name.trim() || !harness.executable.trim()} onClick={onSave}>Save harness</Button></footer>
      </div>
    </div>
  );
}

function splitArgs(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}
