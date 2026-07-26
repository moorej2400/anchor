/** Small inline confirm popover (delete-session). Positioned by the caller. */
import type { CSSProperties } from "react";
import { Button } from "./Button";

interface ConfirmPopoverProps {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (e: React.MouseEvent) => void;
  onCancel: (e: React.MouseEvent) => void;
  style?: CSSProperties;
}

export function ConfirmPopover({
  title,
  body,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  style,
}: ConfirmPopoverProps) {
  return (
    <div className="a-confirm" style={style} onClick={(e) => e.stopPropagation()}>
      <div className="a-confirm__title">{title}</div>
      <div className="a-confirm__body">{body}</div>
      <div className="a-confirm__row">
        <Button variant="subtle" block onClick={onCancel} style={{ padding: "6px 0" }}>
          {cancelLabel}
        </Button>
        <Button variant="danger" block onClick={onConfirm} style={{ padding: "6px 0", fontWeight: 600 }}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
