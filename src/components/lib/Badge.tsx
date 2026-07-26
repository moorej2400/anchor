/** Tool badge — the two-glyph monogram (cc / cx / co / oc / ›_). */
import type { CSSProperties } from "react";
import type { Tool } from "../../ipc/types";
import { TOOL_BADGE } from "./tokens";

interface BadgeProps {
  tool: Tool;
  /** Visual scale multiplier (default 1); mock enlarges to 1.35 on the resume card. */
  scale?: number;
  style?: CSSProperties;
  title?: string;
}

export function Badge({ tool, scale = 1, style, title }: BadgeProps) {
  const b = TOOL_BADGE[tool];
  return (
    <span
      className="a-badge"
      title={title}
      style={{
        color: b.fg,
        background: b.bg,
        ...(scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: "left" } : null),
        ...style,
      }}
    >
      {b.label}
    </span>
  );
}
