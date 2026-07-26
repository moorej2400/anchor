/** Hover tooltip wrapper (CSS-driven; no positioning library). */
import type { ReactNode } from "react";

interface TooltipProps {
  label: string;
  children: ReactNode;
}

export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className="a-tip">
      {children}
      <span className="a-tip__bubble" role="tooltip">
        {label}
      </span>
    </span>
  );
}
