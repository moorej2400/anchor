/** Apply user settings to the token CSS variables on :root. */
import type { Settings } from "../ipc/types";

export function applyTheme(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.density = settings.density;
  root.style.setProperty("--acc", settings.accent);
  root.style.setProperty("--tfs", `${settings.fontSize}px`);
}
