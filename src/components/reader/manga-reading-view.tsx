import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { recognizeBlockNow } from "@/core/ocr/ocr";
import { loadManga, type MangaRecord } from "@/core/storage";
import { usePagingInput } from "./use-paging-input";
import { useSpreadNav } from "./use-spread-nav";
import { useZoomPan } from "./use-zoom-pan";
import { setKey, useMangaPages, type ViewPage } from "./use-manga-pages";
import { useMangaOcrBlocks } from "./use-manga-ocr-blocks";
import { useMangaTouch } from "./use-manga-touch";
import {
  COMPACT_STAGE_PX,
  MANGA_SPREAD_MIN_WIDTH,
  PAGE_MARGIN,
  SPREAD_MIN_ASPECT,
  fitScale,
  neighborFirst,
  spreadFirstOf,
  visibleNums,
} from "./spread-paging";
import { PageIndicator } from "./page-indicator";
import { MangaOcrOverlay } from "./manga-ocr-overlay";

// Manga reader: scanned pages, right-to-left. Same book metaphor as the PDF
// reader — on landscape stages a spread (cover alone, then pairs; the
// EARLIER page of a pair sits on the right), on portrait ones a single page,
// visible pages always fitted whole; left means forward, as in a Japanese
// book. A phone-sized stage drops the outer margin — the page takes it all.
//   The stage is a PAGER TRACK of three slots: the current set, the next set
// on its left and the previous one on its right, both preloaded. A desktop
// flips with wheel-free input (keys, clicks beside the page) and zooms with
// the wheel; fingers drag the track itself (useMangaTouch). Page scans never
// enter React state: blobs become object URLs in a small window around the
// current page and are revoked beyond it. OCR boxes ride on the current
// set in source-image coordinates.
//   Position: a page number, derived from the stored 0..1 progress.

export function MangaReadingView({
  bookId,
  initialProgress = 0,
  mangaFirstPageAsCover = true,
  onProgress,
  controlsVisible = false,
  onControlsChange,
}: {
  bookId: string;
  initialProgress?: number;
  /** True: page 1 is a solo cover, then [2,3], [4,5]… False: [1,2], [3,4]… */
  mangaFirstPageAsCover?: boolean;
  /** Fraction read + absolute position (first visible page, 1-based) + how
      many pages the visible set holds. */
  onProgress?: (progress: number, absolute: number, pageCount: number) => void;
  /** Touch controls are up (the scrubber bar replaces the page chip). */
  controlsVisible?: boolean;
  onControlsChange?: (visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const outerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pageSetRef = useRef<HTMLDivElement>(null);
  const [record, setRecord] = useState<MangaRecord | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  // Which blank margin the cursor is over — those turn the page on click.
  const [hoverSide, setHoverSide] = useState<"left" | "right" | null>(null);
  // Bumped to close an open OCR box (a tap elsewhere on the page).
  const [ocrDismiss, setOcrDismiss] = useState(0);
  const zoom = useZoomPan({
    targetRef: outerRef,
    layerRef: pageSetRef,
    enabled: record !== null,
  });
  const { pageRef, spreadRef, numPagesRef, stepFor, goTo } = useSpreadNav({
    firstPageAsCover: mangaFirstPageAsCover,
    onNavigate: (target) => {
      setPage(target);
      zoom.reset();
    },
  });

  const numPages = record?.pages.length ?? 0;
  numPagesRef.current = Math.max(1, numPages);

  // Load the volume's page metadata; the stored progress becomes the page.
  useEffect(() => {
    let alive = true;
    loadManga(bookId)
      .then((loaded) => {
        if (!alive) return;
        if (!loaded || loaded.pages.length === 0) {
          setFailed(true);
          return;
        }
        setRecord(loaded);
        const restored = Math.max(
          1,
          Math.min(
            loaded.pages.length,
            Math.round(initialProgress * (loaded.pages.length - 1)) + 1,
          ),
        );
        pageRef.current = restored;
        setPage(restored);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Track the stage size: the spread/single decision and the fit scale.
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const ro = new ResizeObserver(() => {
      setViewport({ w: outer.clientWidth, h: outer.clientHeight });
    });
    ro.observe(outer);
    return () => ro.disconnect();
  }, []);

  const margin =
    Math.min(viewport.w, viewport.h) < COMPACT_STAGE_PX ? 0 : PAGE_MARGIN;
  const availW = Math.max(1, viewport.w - 2 * margin);
  const availH = Math.max(1, viewport.h - 2 * margin);
  const spread =
    viewport.w > 0 &&
    availW / availH >= SPREAD_MIN_ASPECT &&
    availW >= MANGA_SPREAD_MIN_WIDTH;
  spreadRef.current = spread;

  // Normalize the anchor to a spread boundary (31 → 30 shows [30,31]).
  const first = spread ? spreadFirstOf(page, mangaFirstPageAsCover) : page;
  const nums = record
    ? visibleNums(first, spread, numPages, mangaFirstPageAsCover)
    : [];
  const nextFirst = record
    ? neighborFirst(first, 1, spread, numPages, mangaFirstPageAsCover)
    : null;
  const prevFirst = record
    ? neighborFirst(first, -1, spread, numPages, mangaFirstPageAsCover)
    : null;
  const nextNums =
    nextFirst !== null
      ? visibleNums(nextFirst, spread, numPages, mangaFirstPageAsCover)
      : null;
  const prevNums =
    prevFirst !== null
      ? visibleNums(prevFirst, spread, numPages, mangaFirstPageAsCover)
      : null;

  const loaded = useMangaPages({
    bookId,
    record,
    sets: [nums, nextNums, prevNums].filter(
      (set): set is number[] => set !== null && set.length > 0,
    ),
    numPages,
    onProgress,
  });
  // A far jump keeps the last shown set on screen until the new one lands.
  const shownRef = useRef<ViewPage[] | null>(null);
  const currentPages = loaded.get(setKey(nums)) ?? shownRef.current;
  useEffect(() => {
    if (currentPages) shownRef.current = currentPages;
  }, [currentPages]);
  const nextPages = nextNums ? loaded.get(setKey(nextNums)) : undefined;
  const prevPages = prevNums ? loaded.get(setKey(prevNums)) : undefined;

  // In-app OCR blocks for pages that came without a sidecar (0-based index).
  const ocrBlocks = useMangaOcrBlocks(bookId, record);

  usePagingInput({
    targetRef: outerRef,
    vertical: true,
    enabled: record !== null,
    wheel: false,
    clickBoundsRef: pageSetRef,
    onStep: (dir) => goTo(pageRef.current + stepFor(dir)),
  });

  const { afterTurn } = useMangaTouch({
    stageRef: outerRef,
    trackRef,
    layerRef: pageSetRef,
    enabled: record !== null,
    zoom,
    canTurn: (dir) => (dir > 0 ? nextFirst : prevFirst) !== null,
    neighborReady: (dir) => (dir > 0 ? nextPages : prevPages) !== undefined,
    onTurn: (dir) => {
      const target = dir > 0 ? nextFirst : prevFirst;
      if (target === null) return;
      goTo(target);
      onControlsChange?.(false);
    },
    onMenu: () => onControlsChange?.(!controlsVisible),
    onDismissOcr: () => {
      if (!outerRef.current?.querySelector("[data-ocr-block][data-open]"))
        return false;
      setOcrDismiss((n) => n + 1);
      return true;
    },
  });
  // Every page change lands the track: a finger turn slides home on its
  // spring, anything else (keys, scrubber, rotation) snaps to rest.
  useLayoutEffect(() => {
    afterTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);

  if (failed) {
    return (
      <div className="grid h-full w-full place-items-center bg-canvas">
        <p className="text-sm text-muted-content">{t("reader.mangaError")}</p>
      </div>
    );
  }

  // Current set at 0, next on the LEFT (right-to-left reading), previous on
  // the right. Slots are keyed by their pages, so the set a finger pulls in
  // keeps its DOM — and its decoded images — as it becomes current.
  const slots: { pages: ViewPage[]; offset: number }[] = [];
  if (currentPages) slots.push({ pages: currentPages, offset: 0 });
  // While a jump loads, the held set may also be a neighbour — show it once.
  const shownKey = currentPages ? setKey(currentPages.map((p) => p.num)) : "";
  for (const [pages, offset] of [
    [nextPages, -1],
    [prevPages, 1],
  ] as const) {
    if (pages && setKey(pages.map((p) => p.num)) !== shownKey)
      slots.push({ pages, offset });
  }
  const lastNum = nums[nums.length - 1] ?? first;

  return (
    <div
      ref={outerRef}
      className={`relative h-full w-full touch-none overflow-hidden select-none ${
        hoverSide
          ? "cursor-pointer"
          : zoom.zoomed
            ? "cursor-grab active:cursor-grabbing"
            : ""
      }`}
      style={{
        background: "var(--reading-bg, var(--ds-surface-canvas))",
        // A long press on a scan is not "save image".
        WebkitTouchCallout: "none",
      }}
      data-manga-page={currentPages?.[0]?.num ?? ""}
      // No native drags on the stage, ever: an accidental press-and-move would
      // otherwise drag the page image (or a stray selection) as a ghost.
      onDragStart={(event) => event.preventDefault()}
      onMouseMove={(event) => {
        const el = pageSetRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const side =
          event.clientX < rect.left
            ? "left"
            : event.clientX > rect.right
              ? "right"
              : null;
        setHoverSide((prev) => (prev === side ? prev : side));
      }}
      onMouseLeave={() => setHoverSide(null)}
      {...zoom.handlers}
    >
      <div ref={trackRef} className="absolute inset-0 will-change-transform">
        {slots.map(({ pages, offset }) => {
          const current = offset === 0;
          const scale = fitScale(pages, availW, availH, 0);
          return (
            <div
              key={setKey(pages.map((viewPage) => viewPage.num))}
              className="absolute inset-0 grid place-items-center"
              style={offset ? { transform: `translateX(${offset * 100}%)` } : undefined}
              aria-hidden={current ? undefined : true}
            >
              <div
                ref={current ? pageSetRef : undefined}
                // Test seam: the set on screen (neighbours wait off-stage).
                data-manga-current={current ? "" : undefined}
                className="flex flex-row-reverse items-center gap-0"
              >
                {pages.map((viewPage) => {
                  const meta = record?.pages[viewPage.num - 1];
                  // The sidecar always wins; in-app OCR fills the pages without one.
                  const fromSidecar = !!(meta?.blocks && meta.blocks.length > 0);
                  const blocks = fromSidecar
                    ? meta.blocks
                    : ocrBlocks.get(viewPage.num - 1);
                  return (
                    <div
                      key={viewPage.num}
                      className="relative"
                      style={{
                        width: Math.round(viewPage.width * scale),
                        height: Math.round(viewPage.height * scale),
                      }}
                    >
                      <img
                        src={viewPage.url}
                        alt={`${viewPage.num}`}
                        className="absolute inset-0 size-full"
                        decoding="async"
                        draggable={false}
                      />
                      {current && blocks && blocks.length > 0 ? (
                        <MangaOcrOverlay
                          blocks={blocks}
                          width={viewPage.width}
                          height={viewPage.height}
                          scale={scale}
                          reestimateFontSize={!fromSidecar}
                          dismissKey={ocrDismiss}
                          onRevealBlock={(blockIndex) =>
                            recognizeBlockNow(bookId, viewPage.num - 1, blockIndex)
                          }
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {record ? (
        <PageIndicator
          page={first}
          pageLast={lastNum}
          pages={numPages}
          jumpMin={1}
          jumpMax={numPages}
          jumpStep={1}
          jumpValue={first}
          jumpLabel={t("reader.jumpPage")}
          jumpSubmitLabel={t("reader.jump")}
          onJump={(value) => goTo(Math.round(value))}
          expanded={controlsVisible}
          rtl
          formatJump={(value) => `${Math.round(value)} / ${numPages}`}
        >
          {first === lastNum
            ? `${first} / ${numPages}`
            : `${first}–${lastNum} / ${numPages}`}
        </PageIndicator>
      ) : null}
    </div>
  );
}
