import { Minus, Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

// Numeric stepper: minus / tabular value / plus, one control for the one action
// both the reader chrome and the settings dialog need (font size). `display`
// overrides the rendered value when the raw number needs formatting
// (thousands separator for the daily reading goal).
export function Stepper({
  value,
  display,
  onStep,
  canDecrement,
  canIncrement,
  decreaseLabel,
  increaseLabel,
}: {
  value: number;
  display?: string;
  onStep: (delta: 1 | -1) => void;
  canDecrement: boolean;
  canIncrement: boolean;
  decreaseLabel: string;
  increaseLabel: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={decreaseLabel}
        disabled={!canDecrement}
        onClick={() => onStep(-1)}
      >
        <Minus />
      </Button>
      <span className="min-w-8 text-center text-sm text-strong tabular-nums">
        {display ?? value}
      </span>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={increaseLabel}
        disabled={!canIncrement}
        onClick={() => onStep(1)}
      >
        <Plus />
      </Button>
    </div>
  );
}
