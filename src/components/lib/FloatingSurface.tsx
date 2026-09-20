import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { placeFloatingSurface } from "./floatingPlacement";

interface FloatingSurfaceProps {
  anchorRef: RefObject<HTMLElement | null>;
  className: string;
  style?: CSSProperties;
  width?: number;
  children: ReactNode;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  role?: string;
}

export function FloatingSurface({
  anchorRef,
  className,
  style,
  width,
  children,
  onClick,
  role,
}: FloatingSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; placement: "above" | "below" } | null>(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const anchor = anchorRef.current;
    if (!surface || !anchor) return;

    const update = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      setPosition(placeFloatingSurface(
        anchorRect,
        surfaceRect,
        { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight },
      ));
    };

    // Menus are measured after mounting because their height depends on their
    // items. Fixed positioning plus a body portal avoids clipping ancestors.
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resizeObserver?.observe(surface);
    resizeObserver?.observe(anchor);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={surfaceRef}
      className={className}
      data-placement={position?.placement}
      role={role}
      style={{
        width,
        ...style,
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        right: "auto",
        visibility: position ? "visible" : "hidden",
      }}
      onClick={onClick}
    >
      {children}
    </div>,
    document.body,
  );
}
