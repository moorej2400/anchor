/**
 * Floating popover menu (folder `⋯` and `+` menus, session `⋯` menu).
 * The shared floating layer keeps menus within the app window and outside
 * clipping scroll containers.
 */
import type { CSSProperties, ReactNode, RefObject } from "react";
import { cx } from "./cx";
import { FloatingSurface } from "./FloatingSurface";

interface MenuProps {
  anchorRef?: RefObject<HTMLElement | null>;
  style?: CSSProperties;
  width?: number;
  children: ReactNode;
}

export function Menu({ anchorRef, style, width, children }: MenuProps) {
  if (anchorRef) {
    return (
      <FloatingSurface
        anchorRef={anchorRef}
        className="a-menu"
        role="menu"
        style={style}
        width={width}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </FloatingSurface>
    );
  }

  return (
    <div
      className="a-menu"
      role="menu"
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
