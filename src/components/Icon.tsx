import type { ReactNode, SVGProps } from "react";
import { cx } from "./lib/cx";

export type IconName =
  | "anchor"
  | "archive"
  | "arrow-left"
  | "bell"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "copy"
  | "edit"
  | "folder"
  | "info"
  | "keyboard"
  | "more"
  | "palette"
  | "panel"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "star"
  | "stop"
  | "terminal"
  | "trash"
  | "warning"
  | "wrench";

const drawings: Record<IconName, ReactNode> = {
  // Keep this mark aligned with src-tauri/icons/icon.svg, which generates the
  // installed executable, taskbar, dock, and package icons.
  anchor: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <path d="M12 7.5V20M6 12h12M6 12c0 4 2.2 7 6 8M18 12c0 4-2.2 7-6 8" />
    </>
  ),
  archive: <path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6" />,
  "arrow-left": <path d="m15 18-6-6 6-6M9 12h11" />,
  bell: <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />,
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  close: <path d="m7 7 10 10M17 7 7 17" />,
  copy: <path d="M9 9h11v11H9zM4 15V4h11" />,
  edit: <path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z" />,
  folder: <path d="M3 6h7l2 2h9v11H3z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  palette: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="8" cy="9" r="1" />
      <circle cx="12" cy="7" r="1" />
      <circle cx="16" cy="9" r="1" />
      <path d="M12 21a3 3 0 0 1 0-6h2a2 2 0 0 0 2-2" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <path d="M20 7v5h-5M4 17v-5h5M18.5 9A7 7 0 0 0 6.8 6.8L4 12M5.5 15A7 7 0 0 0 17.2 17.2L20 12" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />,
  warning: <path d="M12 3 2.8 20h18.4L12 3ZM12 9v5M12 17h.01" />,
  wrench: <path d="M14 6a4 4 0 0 0-5 5L3 17l4 4 6-6a4 4 0 0 0 5-5l-3 3-3-3 2-4Z" />,
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  name: IconName;
  size?: number;
}

/**
 * Renders controls as inline SVG; Windows fallback fonts previously dropped
 * the settings, panel, and chevron glyphs used by the sidebar.
 */
export function Icon({ name, size = 16, className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cx("app-icon", className)}
      {...props}
    >
      {drawings[name]}
    </svg>
  );
}
