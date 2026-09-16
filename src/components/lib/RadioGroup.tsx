/** Single-select pill group (theme, density). */
interface RadioOption<T extends string> {
  value: T;
  label: string;
}

interface RadioGroupProps<T extends string> {
  value: T;
  options: RadioOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}

export function RadioGroup<T extends string>({ value, options, onChange, ariaLabel }: RadioGroupProps<T>) {
  return (
    <div className="a-radios" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-on={value === o.value}
          className="a-radio"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
