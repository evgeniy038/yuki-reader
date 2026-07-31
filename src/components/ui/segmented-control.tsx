import { cn } from "@/lib/utils";
import { useSlidingIndicator } from "@/lib/use-sliding-indicator";

interface Segment<T extends string> {
  value: T;
  label: string;
}

// Quiet macOS-style segmented control: gray track, the chosen segment lifts as
// a white card — the accent is reserved for real actions, not for switching.
// The white card is ONE indicator (useSlidingIndicator): switching slides it
// to the new segment with a transform-only 150ms move — the morph is visible
// and cheap. Used wherever 2–4 mutually exclusive options sit (reading
// font, ...).
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const { containerRef, pos } = useSlidingIndicator<HTMLDivElement>(value);

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className="relative flex gap-0.5 rounded-lg bg-muted-surface p-1"
    >
      {pos ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 bottom-1 left-0 rounded-md bg-raised shadow-card transition-transform"
          style={{ transform: `translateX(${pos.x}px)`, width: pos.w }}
        />
      ) : null}
      {segments.map((segment) => {
        const active = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-indicator-target={segment.value}
            onClick={() => onChange(segment.value)}
            className={cn(
              "relative flex-1 cursor-pointer rounded-md px-2 py-1 text-sm whitespace-nowrap transition-colors",
              active ? "text-strong" : "text-default hover:text-strong",
            )}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
