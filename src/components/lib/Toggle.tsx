/** On/off switch used throughout Settings. */
interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  "aria-label"?: string;
}

export function Toggle({ on, onChange, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-on={on}
      className="a-toggle"
      onClick={() => onChange(!on)}
      {...rest}
    >
      <span className="a-toggle__knob" />
    </button>
  );
}
