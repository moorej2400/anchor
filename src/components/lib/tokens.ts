/**
 * Design tokens — extracted from the authoritative mock (docs/Anchor.dc.html).
 * These are the TypeScript mirror of tokens.css, for the few places that need
 * token values in dynamic inline styles (tool badges, status dots, the xterm
 * color palette). UI styling flows through the CSS variables in tokens.css so
 * theme / accent / density settings apply globally, not per component.
 */
import type { Status, Tool } from "../../ipc/types";

/** Per-tool badge: short label, foreground, translucent background. */
export const TOOL_BADGE: Record<Tool, { label: string; fg: string; bg: string; name: string }> = {
  claude: { label: "cc", fg: "#e6a07c", bg: "rgba(230,140,90,.15)", name: "Claude Code" },
  codex: { label: "cx", fg: "#6fd0a0", bg: "rgba(90,200,150,.15)", name: "Codex" },
  copilot: { label: "co", fg: "#8fb3f0", bg: "rgba(110,150,240,.15)", name: "Copilot" },
  opencode: { label: "oc", fg: "#c79bec", bg: "rgba(180,120,240,.15)", name: "opencode" },
  terminal: { label: "›_", fg: "rgba(255,255,255,.7)", bg: "rgba(255,255,255,.08)", name: "Terminal" },
};

/** Status indicator color. `stopped` renders no dot (null). */
export const STATUS_COLOR: Record<Status, string | null> = {
  running: "#5fb891",
  waiting: "#d4a35f",
  stopped: null,
};

export const STATUS_LABEL: Record<Status, string> = {
  running: "running",
  waiting: "waiting",
  stopped: "stopped",
};

/** Informational fallback model label per tool (used only when backend model is null). */
export const TOOL_MODEL_FALLBACK: Record<Tool, string> = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  opencode: "opencode",
  terminal: "shell",
};

/** Accent swatch options offered in Appearance settings. */
export const ACCENT_SWATCHES = [
  "#d6417a",
  "#e0445a",
  "#c93a8b",
  "#a03cc0",
  "#5b6ee0",
  "#3ba6c0",
] as const;

/**
 * Terminal color palette (matches the mock's TC map). Consumed by the xterm
 * theme so real CLI output uses the same accents as the rest of the app.
 */
export const TERMINAL_THEME = {
  background: "rgba(0,0,0,0)",
  foreground: "rgba(255,255,255,.86)",
  dim: "rgba(255,255,255,.42)",
  green: "#4fd598",
  pink: "#e07aa0",
  violet: "#b98be6",
  blue: "#77b6f2",
  amber: "#f0b455",
  red: "#f0757f",
} as const;
