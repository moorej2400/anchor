/** A session row in the sidebar. Active rows get the gradient left edge. */
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

interface SidebarRowProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean;
  children: ReactNode;
}

export function SidebarRow({ active, className, children, ...rest }: SidebarRowProps) {
  return (
    <div className={cx("a-row", className)} {...rest}>
      {active && <div className="a-row__bg" />}
      {active && <div className="a-row__edge" />}
      {children}
    </div>
  );
}
