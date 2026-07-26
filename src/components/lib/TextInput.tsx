/** Text input with variants: default, mono, inline-rename, seamless (filter). */
import { forwardRef, type InputHTMLAttributes } from "react";
import { cx } from "./cx";

type Variant = "default" | "mono" | "inline" | "seamless";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: Variant;
}

const VARIANT_CLASS: Record<Variant, string> = {
  default: "",
  mono: "a-input--mono",
  inline: "a-input--inline",
  seamless: "a-input--seamless",
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { variant = "default", className, ...rest },
  ref,
) {
  return (
    <input ref={ref} className={cx("a-input", VARIANT_CLASS[variant], className)} {...rest} />
  );
});
