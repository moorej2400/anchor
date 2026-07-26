/** A tab in the top strip. Active tabs get the gradient top edge. */
import type { ReactNode } from "react";
import { cx } from "./cx";

interface TabProps {
  active?: boolean;
  onSelect?: () => void;
  className?: string;
  children: ReactNode;
}

export function Tab({ active, onSelect, className, children }: TabProps) {
  return (
    <div className={cx("a-tab", className)} onClick={onSelect}>
      {active && <div className="a-tab__bg" />}
      {active && <div className="a-tab__edge" />}
      {children}
    </div>
  );
}
