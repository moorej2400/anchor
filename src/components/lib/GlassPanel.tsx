/** Frosted-glass surface — the app's recurring panel/card background. */
import type { HTMLAttributes } from "react";
import { cx } from "./cx";

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  bordered?: boolean;
}

export function GlassPanel({ bordered = true, className, ...rest }: GlassPanelProps) {
  return (
    <div
      className={cx("a-glass", bordered && "a-glass--bordered", className)}
      {...rest}
    />
  );
}
