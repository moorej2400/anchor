/**
 * Dev-only component gallery — renders every library primitive in its variants
 * for visual review. Open with `#gallery` in the URL (see main.tsx). Not part
 * of the shipped app surface.
 */
import { useState } from "react";
import {
  ACCENT_SWATCHES,
  Badge,
  Button,
  ConfirmPopover,
  GlassPanel,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  MenuLabel,
  RadioGroup,
  SidebarRow,
  Slider,
  StatusDot,
  Tab,
  TextInput,
  Toast,
  Toggle,
  Tooltip,
} from "./lib";
import type { Status, Tool } from "../ipc/types";

const TOOLS: Tool[] = ["claude", "codex", "copilot", "opencode", "terminal"];
const STATUSES: Status[] = ["running", "waiting", "stopped"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 34 }}>
      <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".09em", color: "var(--text-3)", marginBottom: 14 }}>
        {title}
      </h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>{children}</div>
    </section>
  );
}

export function Gallery() {
  const [toggle, setToggle] = useState(true);
  const [theme, setTheme] = useState("graphite");
  const [size, setSize] = useState(13);
  const [accent, setAccent] = useState<string>(ACCENT_SWATCHES[0]);

  return (
    <div style={{ minHeight: "100%", padding: "40px 48px", maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Anchor component library</h1>
      <p style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 34 }}>
        Every primitive, every variant — built to docs/Anchor.dc.html.
      </p>

      <Section title="Buttons">
        <Button>Default</Button>
        <Button variant="subtle">Subtle</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="primary">↻ Resume session</Button>
        <Button variant="danger">Remove group</Button>
        <Button disabled>Disabled</Button>
      </Section>

      <Section title="Icon buttons">
        <IconButton aria-label="close">✕</IconButton>
        <IconButton bordered aria-label="add">+</IconButton>
        <IconButton danger aria-label="delete">✕</IconButton>
        <Tooltip label="Quick launch">
          <IconButton bordered aria-label="launch">+</IconButton>
        </Tooltip>
      </Section>

      <Section title="Tool badges">
        {TOOLS.map((t) => (
          <Badge key={t} tool={t} />
        ))}
        <Badge tool="claude" scale={1.35} />
      </Section>

      <Section title="Status dots">
        {STATUSES.map((s) => (
          <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
            <StatusDot status={s} /> {s}
          </span>
        ))}
      </Section>

      <Section title="Toggle / Radio / Slider">
        <Toggle on={toggle} onChange={setToggle} aria-label="demo" />
        <RadioGroup
          value={theme}
          onChange={setTheme}
          options={[
            { value: "graphite", label: "Graphite" },
            { value: "obsidian", label: "Obsidian" },
            { value: "nebula", label: "Nebula" },
          ]}
        />
        <div style={{ width: 220 }}>
          <Slider value={size} min={11} max={18} onChange={setSize} aria-label="font size" />
        </div>
      </Section>

      <Section title="Accent swatches">
        {ACCENT_SWATCHES.map((hex) => (
          <button
            key={hex}
            onClick={() => setAccent(hex)}
            title={hex}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              cursor: "pointer",
              background: hex,
              border: accent === hex ? "2px solid #fff" : "2px solid rgba(255,255,255,.15)",
              boxShadow: `0 3px 10px ${hex}66`,
            }}
          />
        ))}
      </Section>

      <Section title="Text inputs">
        <div style={{ width: 220 }}>
          <TextInput placeholder="Default input" />
        </div>
        <div style={{ width: 220 }}>
          <TextInput variant="mono" placeholder="~/dev/acme-web" />
        </div>
        <div style={{ width: 160 }}>
          <TextInput variant="inline" defaultValue="rename me" />
        </div>
      </Section>

      <Section title="Tabs">
        <div style={{ display: "flex" }}>
          <Tab active>
            <Badge tool="claude" />
            <span className="a-tab__title">refactor auth middleware</span>
            <StatusDot status="running" />
          </Tab>
          <Tab>
            <Badge tool="codex" />
            <span className="a-tab__title">fix checkout timers</span>
            <StatusDot status="waiting" />
          </Tab>
        </div>
      </Section>

      <Section title="Sidebar rows">
        <div style={{ width: 280 }}>
          <SidebarRow active>
            <Badge tool="claude" />
            <span className="a-row__title">refactor auth middleware</span>
            <StatusDot status="running" />
          </SidebarRow>
          <SidebarRow>
            <Badge tool="opencode" />
            <span className="a-row__title">stripe webhook retries</span>
            <StatusDot status="stopped" />
          </SidebarRow>
        </div>
      </Section>

      <Section title="Menu">
        <div style={{ position: "relative", width: 236, height: 180 }}>
          <Menu width={236} style={{ position: "relative", top: 0, right: 0 }}>
            <MenuLabel>Launch in acme-web</MenuLabel>
            {TOOLS.map((t) => (
              <MenuItem key={t} icon={<Badge tool={t} />}>
                {t}
              </MenuItem>
            ))}
            <MenuDivider />
            <MenuItem danger icon="✕">
              Remove group
            </MenuItem>
          </Menu>
        </div>
      </Section>

      <Section title="Confirm popover / Toast">
        <div style={{ position: "relative", width: 230, height: 120 }}>
          <ConfirmPopover
            title="Delete this session?"
            body="Its saved session ID will be removed."
            onConfirm={() => {}}
            onCancel={() => {}}
            style={{ position: "relative", top: 0, right: 0 }}
          />
        </div>
        <div style={{ position: "relative", width: 220, height: 60 }}>
          <div style={{ position: "absolute", left: 0, bottom: 0, transform: "none" }}>
            <GlassPanel style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 16px", borderRadius: 12, fontSize: 12.5 }}>
              <span style={{ color: "var(--acc)" }}>✓</span> Session ID copied
            </GlassPanel>
          </div>
        </div>
      </Section>

      {/* Live toast so its animation/position can be reviewed in place. */}
      <Toast text="Session ID copied" />
    </div>
  );
}
