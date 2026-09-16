/** Apply user settings to the token CSS variables on :root. */
import type { Settings } from "../ipc/types";

export function applyTheme(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.density = settings.density;
  root.style.setProperty("--acc", settings.accent);
  root.style.setProperty("--tfs", `${settings.fontSize}px`);
  root.style.setProperty("--terminal", settings.terminalTheme.background);
  root.style.setProperty("--terminal-text", settings.terminalTheme.foreground);
  root.style.setProperty("--terminal-green", settings.terminalTheme.green);
  root.style.setProperty("--terminal-cyan", settings.terminalTheme.cyan);
  root.style.setProperty("--terminal-purple", settings.terminalTheme.magenta);
  root.style.setProperty("--terminal-yellow", settings.terminalTheme.yellow);
}
