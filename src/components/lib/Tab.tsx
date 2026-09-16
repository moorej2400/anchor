/** A tab in the top strip. Active tabs get a flat accent edge. */
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

interface TabProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick"> {
  active?: boolean;
  onSelect?: () => void;
  className?: string;
  children: ReactNode;
}

export function Tab({ active, onSelect, className, children, ...divProps }: TabProps) {
  return (
    <div {...divProps} className={cx("a-tab", className)} onClick={onSelect}>
      {active && <div className="a-tab__bg" />}
      {active && <div className="a-tab__edge" />}
      {children}
    </div>
  );
}
