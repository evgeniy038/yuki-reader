import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The quiet page chip at the bottom-right of every reader: reading-muted ink.
// The data-* attrs are the test seam (smoke tests read the position counters
// off them) — keep them verbatim. With onJump wired up the chip becomes a
// jump-to-page control; its clicks (and the form's) stopPropagation so they
// never page the reader, and Escape inside the form closes it instead of
// firing the reader's own Escape.
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
  children: ReactNode;
}) {
  const interactive = typeof onJump === "function";
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div
      data-page-indicator=""
      data-page={page}
      data-page-last={pageLast}
      data-pages={pages}
      className={cn(
        "fixed bottom-3 right-4 z-50 text-xs",
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
