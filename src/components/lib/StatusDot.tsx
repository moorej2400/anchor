/** Status indicator dot. `stopped` renders nothing (returns null). */
import type { Status } from "../../ipc/types";
import { STATUS_COLOR } from "./tokens";

interface StatusDotProps {
  status: Status;
  size?: number;
}

export function StatusDot({ status, size = 8 }: StatusDotProps) {
  const color = STATUS_COLOR[status];
  if (!color) return null;
  return (
    <span
      className="a-dot"
      style={{ width: size, height: size, background: color, boxShadow: `0 0 6px ${color}88` }}
    />
  );
}
