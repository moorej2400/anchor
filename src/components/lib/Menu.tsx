/**
 * Floating popover menu (folder `⋯` and `+` menus, session `⋯` menu).
 * Positioning is the caller's job (pass `style` with top/right); the menu stops
 * click propagation so the document-level "close menus" handler doesn't fire.
 */
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

interface MenuProps {
  style?: CSSProperties;
  width?: number;
  children: ReactNode;
}

export function Menu({ style, width, children }: MenuProps) {
  return (
    <div
      className="a-menu"
      style={{ width, ...style }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="a-menu__label">{children}</div>;
}

interface MenuItemProps {
  icon?: ReactNode;
  danger?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
}

export function MenuItem({ icon, danger, onClick, children }: MenuItemProps) {
  return (
    <button
      type="button"
      className={cx("a-menu__item", danger && "a-menu__item--danger")}
      onClick={onClick}
    >
      {icon !== undefined && <span className="a-menu__icon">{icon}</span>}
      {children}
    </button>
  );
}

export function MenuDivider() {
  return <div className="a-menu__divider" />;
}
