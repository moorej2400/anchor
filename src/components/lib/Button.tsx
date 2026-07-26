/** Text button with visual variants. Gradient `primary` is the CTA (Resume). */
import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

type Variant = "default" | "ghost" | "subtle" | "primary" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  block?: boolean;
}

const VARIANT_CLASS: Record<Variant, string> = {
  default: "",
  ghost: "a-btn--ghost",
  subtle: "a-btn--subtle",
  primary: "a-btn--primary",
  danger: "a-btn--danger",
};

export function Button({
  variant = "default",
  block,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("a-btn", VARIANT_CLASS[variant], block && "a-btn--block", className)}
      {...rest}
    />
  );
}
