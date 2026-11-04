import { cn } from "@/lib/utils";

// Determinate progress bar — the flat counterpart of ProgressRing: a 4px
// track, the fill riding the primary accent (`media`: white on a cover).
// `value` is 0..1; the fill eases to each new value (none under reduced
// motion), so a stepwise transfer reads as one steady movement.
export function ProgressBar({
  value,
  label,
  tone = "default",
  className,
}: {
  value: number;
  label?: string;
  tone?: "default" | "media";
  className?: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label}
      className={cn(
        "h-1 overflow-hidden rounded-full",
        tone === "media" ? "bg-white/30" : "bg-muted-surface",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
          tone === "media" ? "bg-white" : "bg-primary-gradient",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
