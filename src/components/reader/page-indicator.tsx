import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

// The quiet page chip at the bottom-right of every reader: reading-muted ink.
// The data-* attrs are the test seam (smoke tests read the position counters
// off them) — keep them verbatim. With onJump wired up the chip becomes a
// jump-to-page control; its clicks (and the form's) stopPropagation so they
// never page the reader, and Escape inside the form closes it instead of
// firing the reader's own Escape.
//   Touch: when the reader controls are up (`expanded`), the chip grows into
// a floating bottom bar with a scrubber across the whole book — drag to
// preview the position, let go to jump. A right-to-left book fills it from
// the right, the way its pages run.
export function PageIndicator({
  page,
  pages,
  pageLast,
  jumpMin,
  jumpMax,
  jumpStep,
  jumpValue,
  jumpLabel,
  jumpSubmitLabel,
  onJump,
  expanded = false,
  rtl = false,
  formatJump,
  children,
}: {
  page: number;
  pages: number;
  /** Last visible page (PDF spread); absent when the set is one page. */
  pageLast?: number;
  jumpMin?: number;
  jumpMax?: number;
  jumpStep?: number;
  jumpValue?: number;
  jumpLabel?: string;
  jumpSubmitLabel?: string;
  onJump?: (value: number) => void;
  /** Touch controls are up: show the scrubber bar instead of the chip. */
  expanded?: boolean;
  /** Right-to-left book: the scrubber fills from the right. */
  rtl?: boolean;
  /** Label for a scrubber value while the finger drags it. */
  formatJump?: (value: number) => string;
  children: ReactNode;
}) {
  const interactive = typeof onJump === "function";
  const [open, setOpen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The scrub preview holds until the jump lands (the view's position
  // moves) or the bar hides — no flash back to the old position between.
  useEffect(() => {
    setScrub(null);
  }, [jumpValue, expanded]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onJump) return;
    const raw = String(
      new FormData(event.currentTarget).get("jump-page") ?? "",
    ).trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) return;
    const min = jumpMin ?? -Infinity;
    const max = jumpMax ?? Infinity;
    onJump(Math.min(max, Math.max(min, value)));
    setOpen(false);
  };

  if (expanded && interactive && jumpMin !== undefined && jumpMax !== undefined) {
    return (
      <div
        data-page-indicator=""
        data-page={page}
        data-page-last={pageLast}
        data-pages={pages}
        data-page-bar=""
        className="fixed right-safe-3 bottom-safe-3 left-safe-3 z-50 mx-auto flex max-w-lg animate-in items-center gap-4 rounded-card border border-subtle bg-raised py-2 pr-4 pl-4 shadow-floating fade-in-0 slide-in-from-bottom-2 duration-150"
      >
        <span className="min-w-16 shrink-0 text-xs text-muted-content tabular-nums">
          {scrub !== null && formatJump ? formatJump(scrub) : children}
        </span>
        <Slider
          value={scrub ?? jumpValue ?? jumpMin}
          min={jumpMin}
          max={jumpMax}
          step={jumpStep ?? 1}
          ariaLabel={jumpLabel ?? ""}
          reversed={rtl}
          className="w-full min-w-0 flex-1"
          onValueChange={setScrub}
          onValueCommitted={onJump}
        />
      </div>
    );
  }

  return (
    <div
      data-page-indicator=""
      data-page={page}
      data-page-last={pageLast}
      data-pages={pages}
      className={cn(
        "fixed right-safe-4 bottom-safe-3 z-50 text-xs",
        !interactive && "pointer-events-none",
      )}
      style={{ color: "var(--reading-muted, var(--ds-content-muted))" }}
    >
      {interactive ? (
        <>
          <button
            type="button"
            aria-label={jumpLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((next) => !next);
            }}
            className="cursor-pointer rounded-xs underline-offset-2 outline-none transition-colors hover:underline focus-visible:underline"
          >
            {children}
          </button>
          {open && (
            <form
              onSubmit={handleSubmit}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                setOpen(false);
              }}
              className="absolute bottom-full right-0 z-30 mb-2 flex origin-bottom-right items-end gap-2 rounded-card border border-subtle bg-raised p-2.5 shadow-floating animate-in fade-in-0 zoom-in-95 duration-100"
            >
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-content">{jumpLabel}</span>
                <Input
                  ref={inputRef}
                  name="jump-page"
                  type="number"
                  inputMode="numeric"
                  min={jumpMin}
                  max={jumpMax}
                  step={jumpStep}
                  defaultValue={jumpValue}
                  className="h-8 w-24"
                />
              </label>
              <Button type="submit" size="sm">
                {jumpSubmitLabel}
              </Button>
            </form>
          )}
        </>
      ) : (
        children
      )}
    </div>
  );
}
