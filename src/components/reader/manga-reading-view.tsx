import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { recognizeBlockNow } from "@/core/ocr/ocr";
import { loadManga, type MangaRecord } from "@/core/storage";
import { usePagingInput } from "./use-paging-input";
import { useSpreadNav } from "./use-spread-nav";
import { useZoomPan } from "./use-zoom-pan";
import { useMangaPages } from "./use-manga-pages";
import { useMangaOcrBlocks } from "./use-manga-ocr-blocks";
import {
  PAGE_MARGIN,
  SPREAD_MIN_ASPECT,
  SPREAD_MIN_WIDTH,
  fitScale,
  spreadFirstOf,
  visibleNums,
} from "./spread-paging";
import { PageIndicator } from "./page-indicator";
import { MangaOcrOverlay } from "./manga-ocr-overlay";

// Manga reader: scanned pages, right-to-left. Same book metaphor as the PDF
// reader — on wide screens a spread (cover alone, then pairs; the EARLIER
// page of a pair sits on the right), on narrow screens one page at a time,
// visible pages always fitted whole, navigation is flips only (wheel, keys,
// edge clicks — left means forward, as in a Japanese book).
//   Page scans never enter React state: blobs come from the pages store,
//   become object URLs in a small LRU-ish window around the current page and
//   are revoked beyond it. OCR boxes ride on top in source-image coordinates.
//   Position: a page number, derived from the stored 0..1 progress.

export function MangaReadingView({
  bookId,
  initialProgress = 0,
  mangaFirstPageAsCover = true,
  onProgress,
}: {
  bookId: string;
  initialProgress?: number;
  /** True: page 1 is a solo cover, then [2,3], [4,5]… False: [1,2], [3,4]… */
  mangaFirstPageAsCover?: boolean;
  /** Fraction read + absolute position (first visible page, 1-based) + how
      many pages the visible set holds. */
  onProgress?: (progress: number, absolute: number, pageCount: number) => void;
}) {
  const { t } = useTranslation();
  const outerRef = useRef<HTMLDivElement>(null);
  const pageSetRef = useRef<HTMLDivElement>(null);
  const [record, setRecord] = useState<MangaRecord | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  // Which blank margin the cursor is over — those turn the page on click.
  const [hoverSide, setHoverSide] = useState<"left" | "right" | null>(null);
  // Zoom + pan over the fitted page set: the wheel zooms toward the cursor,
  // a drag pans while zoomed in. Both reset on every page turn.
  const {
    zoomPan,
    zoomed,
    reset: resetZoomPan,
    handlers: zoomPanHandlers,
  } = useZoomPan({ targetRef: outerRef, enabled: record !== null });
  const { pageRef, spreadRef, numPagesRef, stepFor, goTo } = useSpreadNav({
    firstPageAsCover: mangaFirstPageAsCover,
    onNavigate: (target) => {
      setPage(target);
      resetZoomPan();
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

  const availW = Math.max(1, viewport.w - 2 * PAGE_MARGIN);
  const availH = Math.max(1, viewport.h - 2 * PAGE_MARGIN);
  const spread =
    viewport.w > 0 &&
    availW / availH >= SPREAD_MIN_ASPECT &&
    availW >= SPREAD_MIN_WIDTH;
  spreadRef.current = spread;

  // Normalize the anchor to a spread boundary (31 → 30 shows [30,31]).
  const first = spread ? spreadFirstOf(page, mangaFirstPageAsCover) : page;
  const nums = record
    ? visibleNums(first, spread, numPages, mangaFirstPageAsCover)
    : [];

  const view = useMangaPages({
    bookId,
    record,
    first,
    nums,
    numPages,
    onProgress,
  });
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

  if (failed) {
    return (
      <div className="grid h-full w-full place-items-center bg-canvas">
        <p className="text-sm text-muted-content">{t("reader.mangaError")}</p>
      </div>
    );
  }

  const scale = view ? fitScale(view.pages, availW, availH, 0) : 1;

  return (
    <div
      ref={outerRef}
      className={`grid h-full w-full select-none place-items-center overflow-hidden ${
        hoverSide
          ? "cursor-pointer"
          : zoomed
            ? "cursor-grab active:cursor-grabbing"
            : ""
      }`}
      style={{ background: "var(--reading-bg, var(--ds-surface-canvas))" }}
      data-manga-page={view?.pages[0]?.num ?? ""}
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
      {...zoomPanHandlers}
    >
      {view ? (
        <div
          ref={pageSetRef}
          className="flex flex-row-reverse items-center gap-0"
          style={{
            transform: `translate(${zoomPan.x}px, ${zoomPan.y}px) scale(${zoomPan.zoom})`,
          }}
        >
          {view.pages.map((viewPage) => {
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
                  draggable={false}
                />
                {blocks && blocks.length > 0 ? (
                  <MangaOcrOverlay
                    blocks={blocks}
                    width={viewPage.width}
                    height={viewPage.height}
                    scale={scale}
                    reestimateFontSize={!fromSidecar}
                    onRevealBlock={(blockIndex) =>
                      recognizeBlockNow(bookId, viewPage.num - 1, blockIndex)
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {record ? (
        <PageIndicator
          page={first}
          pageLast={nums[nums.length - 1] ?? first}
          pages={numPages}
          jumpMin={1}
          jumpMax={numPages}
          jumpStep={1}
          jumpValue={first}
          jumpLabel={t("reader.jumpPage")}
          jumpSubmitLabel={t("reader.jump")}
          onJump={(value) => goTo(Math.round(value))}
        >
          {first === (nums[nums.length - 1] ?? first)
            ? `${first} / ${numPages}`
            : `${first}–${nums[nums.length - 1]} / ${numPages}`}
        </PageIndicator>
      ) : null}
    </div>
  );
}
