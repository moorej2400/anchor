/** Single-select pill group (theme, density). */
interface RadioOption<T extends string> {
  value: T;
  label: string;
}

interface RadioGroupProps<T extends string> {
  value: T;
  options: RadioOption<T>[];
  onChange: (value: T) => void;
}

export function RadioGroup<T extends string>({ value, options, onChange }: RadioGroupProps<T>) {
  return (
    <div className="a-radios" role="radiogroup">
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
