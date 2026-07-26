/** Square icon-only button (row actions, chevrons, close, quick-launch `+`). */
import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  bordered?: boolean;
  danger?: boolean;
  size?: number;
}

export function IconButton({
  bordered,
  danger,
  size,
  className,
  style,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "a-iconbtn",
        bordered && "a-iconbtn--bordered",
        danger && "a-iconbtn--danger",
        className,
      )}
      style={size ? { width: size, height: size, ...style } : style}
      {...rest}
    />
  );
}
