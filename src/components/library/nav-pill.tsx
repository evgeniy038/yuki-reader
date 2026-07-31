import { Books, ChartLine, Gear } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useSlidingIndicator } from "@/lib/use-sliding-indicator";

export type AppView = "library" | "stats" | "settings";

const ITEMS = [
  { value: "library", Icon: Books },
  { value: "stats", Icon: ChartLine },
  { value: "settings", Icon: Gear },
] as const;

// The app's only chrome: a small floating dock at the bottom center. Three
// destinations, icon over a caption. The active marker is ONE slab
// (useSlidingIndicator) that slides item to item — buttons touch (no gap), so
// the slide reads as a single morph, not three separate highlights. Surface
// steps separate the states: hover sits one step BELOW the active slab
// (muted-surface vs hover-surface) — the two must never read as one. Reading
// apps keep the frame minimal — covers carry the color, not the chrome. The
// reader doesn't render it at all.
export function NavPill({
  view,
  onViewChange,
}: {
  view: AppView;
  onViewChange: (view: AppView) => void;
}) {
  const { t } = useTranslation();
  const { containerRef, pos } = useSlidingIndicator<HTMLDivElement>(view);

  return (
    <nav
      aria-label={t("nav.sections")}
      className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2"
    >
      <div
        ref={containerRef}
        className="relative flex items-center rounded-xl border border-subtle bg-raised p-1 shadow-lg"
      >
        {pos ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 bottom-1 left-0 rounded-lg bg-hover-surface transition-transform"
            style={{ transform: `translateX(${pos.x}px)`, width: pos.w }}
          />
        ) : null}
        {ITEMS.map(({ value, Icon }) => {
          const active = view === value;
          const label = t(`nav.${value}`);
          return (
            <button
              key={value}
              type="button"
              data-view={value}
              data-indicator-target={value}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              onClick={() => onViewChange(value)}
              className={`relative flex w-24 cursor-pointer flex-col items-center gap-1 rounded-lg px-2 py-2 transition-colors ${
                active
                  ? "text-strong"
                  : "text-default hover:bg-muted-surface hover:text-strong"
              }`}
            >
              <Icon className="size-4" />
              <span className="text-xs leading-none">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
