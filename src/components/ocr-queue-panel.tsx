import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretDown, Check } from "@phosphor-icons/react";
import { onOcrStatus, type OcrBookProgress, type OcrStatus } from "@/core/ocr/ocr";
import type { Book } from "@/core/library";
import { useOcrBooks } from "@/components/use-ocr-books";
import { DashRing } from "@/components/ui/dash-ring";

// The OCR queue panel. Per-volume progress straight from storage: detect
// (boxes) → recognize (text) → done. The first unfinished volume is featured
// large; the queue waits below; finished volumes drop to the end with a check.
//
// One surface, two contents: pill and panel are both absolutely positioned,
// so each keeps its natural box; the surface's width/height/radius are set
// from the active content's measurements and a plain CSS transition morphs
// between them (native transitions retarget mid-flight for free — no JS
// animation loop anywhere). Contents crossfade through a blur: outgoing
// leaves fast, incoming appears in the last fraction of the morph. Enter
// and exit are a blur+scale fade on the wrapper driven by one boolean; the
// surface stays mounted (visibility), so there is no mount/unmount dance.
// Reduced motion drops everything but opacity.

const MORPH_MS = 230;
const MORPH_CURVE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Incoming content materializes from ~52% to 100% of the morph: the blur
    lift is slow enough to be seen, and the text only reads once the shape
    is essentially done. */
const CONTENT_DELAY_MS = 120;
const CONTENT_IN_MS = 110;
/** Outgoing content is gone by ~35%. */
const CONTENT_OUT_MS = 70;
const ENTER_EXIT_MS = 160;

const reduceMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Bar({ value, thin = false }: { value: number; thin?: boolean }) {
  return (
    <div
      className={`${thin ? "h-1" : "h-2"} w-full overflow-hidden rounded-full bg-muted-surface`}
    >
      <div
        className="h-full rounded-full bg-primary-gradient transition-[width] duration-300"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

function Cover({ book, className }: { book: Book; className: string }) {
  if (book.cover) {
    return (
      <img
        src={book.cover}
        alt=""
        className={`${className} rounded-media object-cover`}
      />
    );
  }
  return (
    <div
      className={`${className} grid place-items-center rounded-media bg-muted-surface px-1 text-center text-[9px] leading-tight text-muted-content`}
    >
      {book.title}
    </div>
  );
}

export function OcrQueuePanel({
  books,
  defaultCollapsed = false,
}: {
  books: Book[];
  /** Reader mounts this collapsed — reading chrome stays minimal. */
  defaultCollapsed?: boolean;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<OcrStatus>({
    models: null,
    error: null,
  });
  useEffect(() => onOcrStatus(setStatus), []);
  const progress = useOcrBooks();
  const [expanded, setExpanded] = useState(!defaultCollapsed);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Mirror of `expanded` for the ResizeObserver callback. */
  const expandedRef = useRef(expanded);

  const active = progress.filter((entry) => entry.stage !== "done");
  const done = progress.filter((entry) => entry.stage === "done");
  const meta = new Map(books.map((book) => [book.id, book]));
  const downloading = status.models !== null;
  const modelPercent =
    downloading && status.models!.total > 0
      ? Math.min(
          100,
          Math.round((status.models!.loaded / status.models!.total) * 100),
        )
      : null;
  const totalPercent =
    active.length > 0
      ? Math.round(
          (100 * active.reduce((sum, entry) => sum + entry.done, 0)) /
            Math.max(
              1,
              active.reduce((sum, entry) => sum + entry.total, 0),
            ),
        )
      : null;
  const visible = downloading || progress.length > 0 || status.error !== null;

  const stageLabel = (entry: OcrBookProgress) =>
    entry.stage === "detect" ? t("ocr.stage.detect") : t("ocr.stage.recognize");
  const pillText = status.error
    ? t("ocr.error", { message: status.error })
    : downloading
      ? t("ocr.models", { percent: modelPercent ?? 0 })
      : active.length > 0
        ? `${t("ocr.volumes", { count: active.length })} · ${totalPercent ?? 0}%`
        : t("ocr.allDone");

  /** Size the surface to one content's measured box. CSS transitions the
      change; `instant` skips it (first show, reduced motion). */
  const applyGeometry = useCallback((expand: boolean, instant = false) => {
    const surface = surfaceRef.current;
    const pill = pillRef.current;
    const panel = panelRef.current;
    if (!surface || !pill || !panel) return;
    if (instant) surface.style.transitionProperty = "none";
    surface.style.width = `${(expand ? panel : pill).offsetWidth}px`;
    surface.style.height = `${(expand ? panel : pill).offsetHeight}px`;
    surface.style.borderRadius = expand
      ? "16px" // --radius-card
      : `${pill.offsetHeight / 2}px`;
    if (instant) {
      surface.getBoundingClientRect(); // flush before restoring
      surface.style.transitionProperty = "";
    }
  }, []);

  const toggle = (next: boolean) => {
    setExpanded(next);
    expandedRef.current = next;
    applyGeometry(next, reduceMotion());
  };

  // On show: snap the geometry (the wrapper is still fading in from opacity
  // 0, so the snap is invisible). While shown: content resizes (progress
  // text, list growth) are chased with the morph transition.
  useEffect(() => {
    if (!visible) return;
    applyGeometry(expandedRef.current, true);
    const observer = new ResizeObserver(() =>
      applyGeometry(expandedRef.current, reduceMotion()),
    );
    observer.observe(pillRef.current!);
    observer.observe(panelRef.current!);
    return () => observer.disconnect();
  }, [visible, applyGeometry]);

  const reduce = reduceMotion();

  return (
    <div
      data-ocr-status=""
      role="status"
      aria-hidden={!visible}
      className="fixed bottom-4 right-4 z-40"
      style={{
        transformOrigin: "100% 100%", // grows from its bottom-right anchor
        transition: visible
          ? `opacity ${ENTER_EXIT_MS}ms ease-out, filter ${ENTER_EXIT_MS}ms ease-out, transform ${ENTER_EXIT_MS}ms ease-out, visibility 0s`
          : `opacity ${ENTER_EXIT_MS}ms ease-out, filter ${ENTER_EXIT_MS}ms ease-out, transform ${ENTER_EXIT_MS}ms ease-out, visibility 0s ${ENTER_EXIT_MS}ms`,
        opacity: visible ? 1 : 0,
        filter: visible || reduce ? "blur(0px)" : "blur(3px)",
        transform: visible || reduce ? "scale(1)" : "scale(0.96)",
        visibility: visible ? "visible" : "hidden",
      }}
    >
      <div
        ref={surfaceRef}
        className="relative overflow-hidden border border-subtle bg-raised shadow-card"
        style={{
          transition: `width ${MORPH_MS}ms ${MORPH_CURVE}, height ${MORPH_MS}ms ${MORPH_CURVE}, border-radius ${MORPH_MS}ms ${MORPH_CURVE}`,
        }}
      >
        {/* Pill content (collapsed state) — anchored bottom-right. */}
        <div
          ref={pillRef}
          className="absolute bottom-0 right-0 whitespace-nowrap"
          style={{
            transition: expanded
              ? `opacity ${CONTENT_OUT_MS}ms ease-out, filter ${CONTENT_OUT_MS}ms ease-out`
              : `opacity ${CONTENT_IN_MS}ms ease-out ${CONTENT_DELAY_MS}ms, filter ${CONTENT_IN_MS}ms ease-out ${CONTENT_DELAY_MS}ms`,
            opacity: expanded ? 0 : 1,
            filter: expanded && !reduce ? "blur(6px)" : "blur(0px)",
            pointerEvents: expanded ? "none" : "auto",
          }}
        >
          <button
            type="button"
            onClick={() => toggle(true)}
            aria-expanded={expanded}
            aria-label={t("ocr.expand")}
            title={t("ocr.expand")}
            className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-content transition-colors hover:text-strong"
          >
            <DashRing className="size-3.5 shrink-0" />
            {pillText}
          </button>
        </div>
        {/* Panel content (expanded state) — fixed width, height by content. */}
        <div
          ref={panelRef}
          className="absolute bottom-0 right-0 w-80"
          style={{
            transition: expanded
              ? `opacity ${CONTENT_IN_MS}ms ease-out ${CONTENT_DELAY_MS}ms, filter ${CONTENT_IN_MS}ms ease-out ${CONTENT_DELAY_MS}ms`
              : `opacity ${CONTENT_OUT_MS}ms ease-out, filter ${CONTENT_OUT_MS}ms ease-out`,
            opacity: expanded ? 1 : 0,
            filter: !expanded && !reduce ? "blur(6px)" : "blur(0px)",
            pointerEvents: expanded ? "auto" : "none",
          }}
        >
          <div className="flex items-center justify-between px-4 pt-3.5 pb-1.5">
            <p className="text-xs font-medium text-strong">{t("ocr.title")}</p>
            <button
              type="button"
              onClick={() => toggle(false)}
              aria-expanded={expanded}
              aria-label={t("ocr.collapse")}
              title={t("ocr.collapse")}
              className="grid size-6 cursor-pointer place-items-center rounded-full text-muted-content transition-colors hover:bg-muted-surface hover:text-strong"
            >
              <CaretDown weight="bold" className="size-3.5" />
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto px-4 pb-3.5">
            {downloading ? (
              <div className="flex flex-col gap-2 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-xs text-muted-content">
                    {t("ocr.modelsRow")}
                  </p>
                  <p className="shrink-0 text-xs text-muted-content tabular-nums">
                    {modelPercent ?? 0}%
                  </p>
                </div>
                <Bar value={(modelPercent ?? 0) / 100} />
                <p className="text-[11px] leading-tight text-muted-content/70">
                  {t("ocr.modelsHint")}
                </p>
              </div>
            ) : null}
            {active.map((entry, index) => {
              const book = meta.get(entry.bookId);
              if (!book) return null;
              const featured = index === 0;
              return (
                <div
                  key={entry.bookId}
                  className={`flex gap-3 ${featured ? "py-2.5" : "items-center py-2"}`}
                >
                  <Cover
                    book={book}
                    className={featured ? "w-14 shrink-0 aspect-2/3" : "w-6 shrink-0 aspect-2/3"}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p
                        className={`truncate ${featured ? "text-sm" : "text-xs"} text-strong`}
                        title={book.title}
                      >
                        {book.title}
                      </p>
                      <p className="shrink-0 text-xs text-muted-content tabular-nums">
                        {entry.done}/{entry.total}
                      </p>
                    </div>
                    {featured ? (
                      <p className="mt-0.5 text-xs text-muted-content">
                        {stageLabel(entry)}
                      </p>
                    ) : null}
                    <div className={featured ? "mt-1.5" : "mt-1"}>
                      <Bar
                        value={entry.done / Math.max(1, entry.total)}
                        thin={!featured}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            {done.map((entry) => {
              const book = meta.get(entry.bookId);
              if (!book) return null;
              return (
                <div
                  key={entry.bookId}
                  className="flex items-center gap-3 py-2 opacity-70"
                >
                  <Cover book={book} className="w-6 shrink-0 aspect-2/3" />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-content">
                    {book.title}
                  </p>
                  <Check weight="bold" className="size-3.5 shrink-0 text-green-600" />
                </div>
              );
            })}
            {status.error ? (
              <p className="py-1.5 text-xs text-red-600">
                {t("ocr.error", { message: status.error })}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
