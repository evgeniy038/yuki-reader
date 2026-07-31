import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Determinate progress ring — the goal counterpart of the indeterminate
// DashRing loader. `value` is 0..1; the arc rides the primary accent, the
// track stays muted. Children render centered (usually the percent).
const R = 34;
const C = 2 * Math.PI * R;

export function ProgressRing({
  value,
  className,
  children,
}: {
  value: number;
  className?: string;
  children?: ReactNode;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div className={cn("relative", className)}>
      <svg viewBox="0 0 80 80" className="size-full -rotate-90">
        <circle
          cx="40"
          cy="40"
          r={R}
          fill="none"
          strokeWidth="8"
          className="stroke-muted"
        />
        <circle
          cx="40"
          cy="40"
          r={R}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - clamped)}
          className="stroke-primary transition-[stroke-dashoffset]"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}
