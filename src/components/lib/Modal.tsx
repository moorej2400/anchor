/**
 * Centered/anchored modal with scrim. `align` controls vertical placement so
 * both the top-anchored dialogs (new-session, command palette) and the
 * centered destructive modal (remove-folder) share one primitive.
 */
import { useEffect, type ReactNode } from "react";
import type { CSSProperties } from "react";

interface ModalProps {
  onClose: () => void;
  align?: "center" | "top";
  /** Distance from top when align="top" (e.g. "12vh"). */
  topOffset?: string;
  width?: number;
  scrimStyle?: CSSProperties;
  children: ReactNode;
}

export function Modal({
  onClose,
  align = "center",
  topOffset = "16vh",
  width,
  scrimStyle,
  children,
}: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="a-modal-scrim"
      style={{
        placeItems: align === "top" ? "start center" : "center",
        paddingTop: align === "top" ? topOffset : undefined,
        padding: align === "center" ? 24 : undefined,
        ...scrimStyle,
      }}
      onClick={onClose}
    >
      <div
        className="a-modal"
        style={{ width, maxWidth: "92vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
