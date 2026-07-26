/** Range slider (scrollback retention, terminal font size). */
interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  "aria-label"?: string;
}

export function Slider({ value, min, max, step = 1, onChange, ...rest }: SliderProps) {
  return (
    <input
      type="range"
      className="a-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      {...rest}
    />
  );
}
