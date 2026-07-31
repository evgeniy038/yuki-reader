import { Slider as SliderPrimitive } from "@base-ui/react/slider";

// macOS-style slider: quiet gray track, primary-gradient fill, white knob.
// For continuous settings (line height, page margins) where a stepper is too
// coarse.
export function Slider({
  value,
  onValueChange,
  min,
  max,
  step,
  ariaLabel,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
}) {
  return (
    <SliderPrimitive.Root
      value={value}
      onValueChange={(next) => {
        if (typeof next === "number") onValueChange(next);
      }}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      className="relative flex w-40 items-center"
    >
      <SliderPrimitive.Control className="relative flex w-full items-center py-2">
        <SliderPrimitive.Track className="h-2 w-full rounded-full bg-muted-surface">
          <SliderPrimitive.Indicator className="h-full rounded-full bg-primary-gradient" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="size-5 cursor-grab rounded-full border border-subtle bg-white shadow-floating focus-ring active:cursor-grabbing" />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
