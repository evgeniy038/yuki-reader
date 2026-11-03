import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { cn } from "@/lib/utils";

// macOS-style slider: quiet gray track, primary-gradient fill, white knob.
// For continuous settings (line height, page margins) where a stepper is too
// coarse — and the reader's page scrubber, which fills from the right in a
// right-to-left book (`reversed`) and only jumps once the finger lets go
// (`onValueCommitted`).
export function Slider({
  value,
  onValueChange,
  onValueCommitted,
  min,
  max,
  step,
  ariaLabel,
  reversed = false,
  className,
}: {
  value: number;
  onValueChange: (value: number) => void;
  onValueCommitted?: (value: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  /** Fill from the right (a right-to-left book's progress). */
  reversed?: boolean;
  /** Width override (default w-40). */
  className?: string;
}) {
  const direction = reversed ? "rtl" : "ltr";
  return (
    <DirectionProvider direction={direction}>
      <SliderPrimitive.Root
        dir={direction}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "number") onValueChange(next);
        }}
        onValueCommitted={(next) => {
          if (typeof next === "number") onValueCommitted?.(next);
        }}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        className={cn("relative flex w-40 items-center", className)}
      >
        <SliderPrimitive.Control className="relative flex w-full touch-none items-center py-2">
          <SliderPrimitive.Track className="h-2 w-full rounded-full bg-muted-surface">
            <SliderPrimitive.Indicator className="h-full rounded-full bg-primary-gradient" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="size-5 cursor-grab rounded-full border border-subtle bg-white shadow-floating active:cursor-grabbing pointer-coarse:size-6" />
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
    </DirectionProvider>
  );
}
