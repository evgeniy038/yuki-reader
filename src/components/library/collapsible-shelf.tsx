import { CaretDown } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Book, ShelfItem } from "@/core/library";
import { cn } from "@/lib/utils";
import { BookCover } from "./book-cover";
import { GRID_CLASSES } from "./library-grid";

// Collapsible shelf section: a caret header plus a body that folds into a
// stack of the section's first covers. Clicking the caret or the stack
// toggles it. The motion is deliberately plain: the grid fades out while
// the section settles to the stack height and the stack pops in; the
// unfold reverses it. No flying covers — only heights and opacity, so
// there is nothing to misalign. Only the folding grid is clipped (its own
// shrinking box), never the covers. Hovering the stack spreads the back
// covers a little sideways. Reduced motion swaps instantly.

const HEIGHT_MS = 220;
const SETTLE_MS = 260;
const HEIGHT_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

// Base fan offsets + the hover spread (the "untidy" pile).
const LAYER_CLASSES = [
  "",
  "translate-x-1.5 -translate-y-1.5 group-hover:translate-x-3 group-hover:-translate-y-0.5 group-hover:rotate-2",
  "translate-x-3 -translate-y-3 group-hover:translate-x-6 group-hover:translate-y-0.5 group-hover:rotate-[5deg]",
];

function coverBookOf(item: ShelfItem): Book {
  // BookCover speaks Book — a series tile pretends to be one, as in SeriesTile.
  return item.kind === "book"
    ? item.book
    : {
        id: item.id,
        title: item.series,
        cover: item.cover,
        progress: item.progress,
        addedAt: item.addedAt,
      };
}

// The folded section: up to three covers fanned out behind the first one.
function ShelfStack({
  items,
  onExpand,
}: {
  items: ShelfItem[];
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const shown = items.slice(0, 3);
  return (
    <button
      type="button"
      data-shelf-stack
      onClick={onExpand}
      aria-label={t("library.expandSection")}
      className="group relative block w-full cursor-pointer text-left"
    >
      {shown.map((item, i) => (
        <div
          key={coverBookOf(item).id}
          className={cn(
            i === 0 ? "relative" : "absolute inset-0",
            i > 0 && "transition-transform duration-150 ease-out",
            LAYER_CLASSES[i] ?? "",
          )}
          style={{ zIndex: shown.length - i }}
        >
          <div className="rounded-media transition-shadow group-hover:shadow-floating">
            <BookCover book={coverBookOf(item)} />
          </div>
        </div>
      ))}
    </button>
  );
}

function ShelfSectionHeader({
  level,
  collapsed,
  onToggle,
  children,
}: {
  level: "group" | "sub";
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      data-shelf-header
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="group relative flex cursor-pointer items-center"
    >
      <CaretDown
        weight="bold"
        className={cn(
          "absolute left-0 top-1/2 size-3 -translate-y-1/2 text-muted-content opacity-0 -translate-x-1 transition-all duration-150 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100",
          collapsed && "-rotate-90",
        )}
      />
      <span className="inline-block transition-[translate] duration-150 ease-out group-hover:translate-x-4 group-focus-within:translate-x-4">
        {children}
      </span>
    </button>
  );
  return level === "group" ? (
    <h2 className="mb-4 text-sm text-default tabular-nums">{button}</h2>
  ) : (
    <h3 className="mb-3 text-xs text-muted-content">{button}</h3>
  );
}

export function CollapsibleShelf({
  level,
  label,
  collapsed,
  onChange,
  items,
  className,
  children,
}: {
  level: "group" | "sub";
  label: ReactNode;
  collapsed: boolean;
  onChange: (next: boolean) => void;
  /** Section items IN DISPLAY ORDER — the stack fans out the first three
      covers (the caller passes the visible ones). */
  items: ShelfItem[];
  className?: string;
  children: ReactNode;
}) {
  const [animating, setAnimating] = useState(false);
  const animatingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stackWrapRef = useRef<HTMLDivElement | null>(null);

  const showChildren = !collapsed || animating;
  const showStack = collapsed || animating;

  const finish = () => {
    if (wrapRef.current) wrapRef.current.style.cssText = "";
    if (contentRef.current) contentRef.current.style.cssText = "";
    if (stackWrapRef.current) stackWrapRef.current.style.cssText = "";
    animatingRef.current = false;
    setAnimating(false);
  };

  useLayoutEffect(() => {
    if (!animating) return;
    const wrap = wrapRef.current;
    const content = contentRef.current;
    const stackWrap = stackWrapRef.current;
    if (!wrap || !stackWrap) return;

    if (collapsed) {
      // Fold: shrink to the stack height, fade the grid, fade the stack in.
      const stackH = stackWrap.getBoundingClientRect().height;
      stackWrap.style.opacity = "0";
      void wrap.offsetHeight; // commit the start state before transitioning
      wrap.style.transition = `height ${HEIGHT_MS}ms ${HEIGHT_EASE}`;
      wrap.style.height = `${stackH}px`;
      if (content) {
        content.style.transition = `height ${HEIGHT_MS}ms ${HEIGHT_EASE}, opacity 150ms ease-out`;
        content.style.height = "0px";
        content.style.opacity = "0";
      }
      stackWrap.style.transition = "opacity 160ms ease-out 40ms";
      stackWrap.style.opacity = "1";
    } else {
      // Unfold: grow back, fade the stack out and the grid in.
      const contentH = content?.getBoundingClientRect().height ?? 0;
      const stackH = stackWrap.getBoundingClientRect().height;
      if (content) {
        content.style.opacity = "0";
        content.style.height = `${stackH}px`;
        content.style.overflow = "hidden";
      }
      void wrap.offsetHeight;
      wrap.style.transition = `height ${HEIGHT_MS}ms ${HEIGHT_EASE}`;
      wrap.style.height = `${contentH}px`;
      if (content) {
        content.style.transition = `height ${HEIGHT_MS}ms ${HEIGHT_EASE}, opacity 160ms ease-out 30ms`;
        content.style.height = `${contentH}px`;
        content.style.opacity = "1";
      }
      stackWrap.style.transition = "opacity 120ms ease-out";
      stackWrap.style.opacity = "0";
    }

    const timer = window.setTimeout(finish, SETTLE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animating, collapsed]);

  const toggle = () => {
    if (animatingRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onChange(!collapsed);
      return;
    }
    if (!collapsed) {
      // Snapshot the fold start: the section height it shrinks from.
      const wrap = wrapRef.current;
      const content = contentRef.current;
      if (!wrap || !content) {
        onChange(true);
        return;
      }
      const contentH = content.getBoundingClientRect().height;
      wrap.style.height = `${contentH}px`;
      content.style.height = `${contentH}px`;
      content.style.overflow = "hidden";
    } else {
      // Snapshot the unfold start: the section grows from the stack height.
      const wrap = wrapRef.current;
      const stackH = stackWrapRef.current?.getBoundingClientRect().height ?? 0;
      if (wrap && stackH > 0) wrap.style.height = `${stackH}px`;
    }
    animatingRef.current = true;
    setAnimating(true);
    onChange(!collapsed);
  };

  return (
    <div className={className}>
      <ShelfSectionHeader level={level} collapsed={collapsed} onToggle={toggle}>
        {label}
      </ShelfSectionHeader>
      <div ref={wrapRef} className="relative">
        {showChildren ? <div ref={contentRef}>{children}</div> : null}
        {showStack ? (
          <div
            ref={stackWrapRef}
            className={cn(
              GRID_CLASSES,
              // Headroom for the fan: the back covers peek 12px above the
              // stack — keep that strip out of the section header's zone.
              "pt-4",
              animating && "absolute inset-x-0 top-0",
            )}
          >
            <ShelfStack items={items} onExpand={toggle} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
