/** Gray/blue response-attention dot for an open chat. */
import { ATTENTION_COLOR } from "./tokens";

interface AttentionDotProps {
  ready?: boolean;
  size?: number;
}

export function AttentionDot({ ready = false, size = 8 }: AttentionDotProps) {
  const color = ready ? ATTENTION_COLOR.ready : ATTENTION_COLOR.idle;
  return (
    <span
      className="a-dot"
      data-attention={ready ? "ready" : "idle"}
      aria-label={ready ? "AI response ready" : "Open chat"}
      style={{ width: size, height: size, background: color, boxShadow: `0 0 6px ${color}88` }}
    />
  );
}
