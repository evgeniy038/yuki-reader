import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MokuroBlock } from "@/core/mokuro";
import { enqueueDetect, onOcrPage, recognizeBlockNow } from "@/core/ocr/ocr";
import {
  loadManga,
  loadMangaOcr,
  loadMangaPageBlob,
  type MangaRecord,
} from "@/core/storage";
import { useLatest } from "@/lib/use-latest";
import { usePagingInput } from "./use-paging-input";
import { useZoomPan } from "./use-zoom-pan";
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

const PAGE_MARGIN = 16;
const SPREAD_MIN_ASPECT = 1.2;
const SPREAD_MIN_WIDTH = 880;
const GUTTER = 8;
/** Keep object URLs this many pages around the current one. */
const URL_WINDOW = 8;

interface ViewPage {
  num: number;
  url: string;
  width: number;
  height: number;
}

function spreadFirstOf(page: number): number {
  if (page <= 1) return 1;
  return page % 2 === 0 ? page : page - 1;
}

function visibleNums(first: number, spread: boolean, numPages: number): number[] {
  return spread && first > 1 && first + 1 <= numPages ? [first, first + 1] : [first];
}

function fitScale(
  pages: { width: number; height: number }[],
  availW: number,
  availH: number,
): number {
  let totalW = GUTTER * (pages.length - 1);
  let maxH = 1;
  for (const page of pages) {
    totalW += page.width;
    maxH = Math.max(maxH, page.height);
  }
  return Math.min(availW / totalW, availH / maxH);
}

export function MangaReadingView({
  bookId,
  initialProgress = 0,
  onProgress,
}: {
  bookId: string;
  initialProgress?: number;
  /** Fraction read + absolute position (first visible page, 1-based) + how
      many pages the visible set holds. */
  onProgress?: (progress: number, absolute: number, pageCount: number) => void;
}) {
  const { t } = useTranslation();
  const outerRef = useRef<HTMLDivElement>(null);
  const [record, setRecord] = useState<MangaRecord | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  // In-app OCR blocks for pages that came without a sidecar (0-based index).
  const [ocrBlocks, setOcrBlocks] = useState<Map<number, MokuroBlock[]>>(
    new Map(),
  );
  const [view, setView] = useState<{ key: string; pages: ViewPage[] } | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  // Zoom + pan over the fitted page set: the wheel zooms toward the cursor,
  // a drag pans while zoomed in. Both reset on every page turn.
  const {
    zoomPan,
    zoomed,
    reset: resetZoomPan,
    handlers: zoomPanHandlers,
  } = useZoomPan({ targetRef: outerRef, enabled: record !== null });
  const pageRef = useRef(1);
  const spreadRef = useRef(false);
  const numPagesRef = useRef(1);
  const renderTokenRef = useRef(0);
  const urlCacheRef = useRef(new Map<number, string>());
  const sizeCacheRef = useRef(new Map<number, { width: number; height: number }>());
  const onProgressRef = useLatest(onProgress);

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

  // Object URLs die with the view.
  useEffect(() => {
    const cache = urlCacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, [bookId]);

  // In-app OCR for sidecar-less pages (lazy): attach what's already computed,
  // queue detect-only skeletons for the rest as a safety net (the import and
  // the resume pass normally beat the reader to it), and attach fresh results
  // live as the worker finishes pages. Recognition itself is the background
  // march (ocr.ts) plus hover — nothing here re-prioritizes the queue.
  useEffect(() => {
    if (!record) return;
    let alive = true;
    const missing = record.pages.flatMap((meta, index) =>
      meta.blocks && meta.blocks.length > 0 ? [] : [index],
    );
    void loadMangaOcr(bookId).then((map) => {
      // Merge, never replace: live page events may have landed after the
      // storage snapshot was taken — they are newer and must win.
      if (alive && map.size > 0) {
        const blocksMap = new Map(
          [...map].map(([index, rec]) => [index, rec.blocks]),
        );
        setOcrBlocks((prev) => new Map([...blocksMap, ...prev]));
      }
    });
    if (missing.length > 0) {
      enqueueDetect(bookId, missing);
    }
    const unsubscribe = onOcrPage((doneBookId, pageIndex, blocks) => {
      if (doneBookId !== bookId) return;
      setOcrBlocks((prev) => new Map(prev).set(pageIndex, blocks));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [record, bookId]);

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
  const first = spread ? spreadFirstOf(page) : page;
  const nums = record ? visibleNums(first, spread, numPages) : [];

  // Load the visible set (blobs → object URLs, natural sizes from the sidecar
  // or the image itself). Rapid navigation is token-guarded; the previous
  // page stays on screen until the new one is ready.
  useEffect(() => {
    if (!record || nums.length === 0) return;
    const token = (renderTokenRef.current += 1);
    const wanted = new Set<number>();
    for (let n = Math.max(1, nums[0]! - URL_WINDOW); n <= Math.min(numPages, nums[nums.length - 1]! + URL_WINDOW); n++) {
      wanted.add(n);
    }

    const getUrl = async (num: number): Promise<string> => {
      const cached = urlCacheRef.current.get(num);
      if (cached) return cached;
      const blob = await loadMangaPageBlob(bookId, num - 1);
      if (!blob) throw new Error(`missing page ${num}`);
      const url = URL.createObjectURL(blob);
      urlCacheRef.current.set(num, url);
      return url;
    };

    const getSize = async (num: number, url: string) => {
      const cached = sizeCacheRef.current.get(num);
      if (cached) return cached;
      const meta = record.pages[num - 1];
      let size =
        meta?.img_width && meta?.img_height
          ? { width: meta.img_width, height: meta.img_height }
          : undefined;
      if (!size) {
        size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () =>
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error(`bad image ${num}`));
          img.src = url;
        });
      }
      sizeCacheRef.current.set(num, size);
      return size;
    };

    void (async () => {
      try {
        const pages: ViewPage[] = [];
        for (const num of nums) {
          const url = await getUrl(num);
          const size = await getSize(num, url);
          pages.push({ num, url, ...size });
        }
        if (token !== renderTokenRef.current) return;
        // Evict URLs far outside the window.
        for (const [num, url] of urlCacheRef.current) {
          if (!wanted.has(num)) {
            URL.revokeObjectURL(url);
            urlCacheRef.current.delete(num);
          }
        }
        setView({ key: nums.join(","), pages });
        onProgressRef.current?.(
          numPages > 1 ? (nums[0]! - 1) / (numPages - 1) : 1,
          nums[0]!,
          nums.length,
        );
      } catch {
        // a failed page load leaves the previous page on screen
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, first, nums.length, bookId]);

  // Navigation step: one page in single mode; in spread mode the cover flips
  // to 2, then spreads advance by two.
  const stepFor = (dir: 1 | -1): number => {
    if (!spreadRef.current) return dir;
    if (pageRef.current === 1 && dir > 0) return 1;
    return 2 * dir;
  };

  const goTo = (index: number) => {
    const count = numPagesRef.current;
    const max = spreadRef.current ? spreadFirstOf(count) : count;
    let target = Math.max(1, Math.min(max, index));
    if (spreadRef.current && target > 1) target = spreadFirstOf(target);
    if (target === pageRef.current) return;
    pageRef.current = target;
    setPage(target);
    resetZoomPan();
  };

  usePagingInput({
    targetRef: outerRef,
    vertical: true,
    enabled: record !== null,
    wheel: false,
    onStep: (dir) => goTo(pageRef.current + stepFor(dir)),
  });

  if (failed) {
    return (
      <div className="grid h-full w-full place-items-center bg-canvas">
        <p className="text-sm text-muted-content">{t("reader.mangaError")}</p>
      </div>
    );
  }

  const scale = view ? fitScale(view.pages, availW, availH) : 1;

  return (
    <div
      ref={outerRef}
      className={`grid h-full w-full select-none place-items-center overflow-hidden ${
        zoomed ? "cursor-grab active:cursor-grabbing" : ""
      }`}
      style={{ background: "var(--reading-bg, var(--ds-surface-canvas))" }}
      data-manga-page={view?.pages[0]?.num ?? ""}
      // No native drags on the stage, ever: an accidental press-and-move would
      // otherwise drag the page image (or a stray selection) as a ghost.
      onDragStart={(event) => event.preventDefault()}
      {...zoomPanHandlers}
    >
      {view ? (
        <div
          className="flex flex-row-reverse items-center gap-2"
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
        <PageIndicator page={first} pageLast={nums[nums.length - 1] ?? first} pages={numPages}>
          {first === (nums[nums.length - 1] ?? first)
            ? `${first} / ${numPages}`
            : `${first}–${nums[nums.length - 1]} / ${numPages}`}
        </PageIndicator>
      ) : null}
    </div>
  );
}
