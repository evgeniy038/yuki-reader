import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  renderPdfPageView,
  searchPdf,
} from "@/core/pdf";
import { useLatest } from "@/lib/use-latest";
import { currentIndexBefore } from "./panels-data";
import { usePdfDocument } from "./use-pdf-document";
import { usePagingInput } from "./use-paging-input";
import { PageIndicator } from "./page-indicator";
import {
  SearchPanel,
  TocPanel,
  type ReaderPanelMode,
  type SearchResultItem,
} from "./reader-panel";

// PDF reader: a book, not a stack of sheets. On wide screens pages show as a
// SPREAD — cover alone, then physical-book pairs [2,3], [4,5]… (even page
// left, odd right); on narrow screens (phones, portrait) one page at a time.
// The spread is chosen when the viewport is both wide-ish (aspect ≥ 1.2) and
// wide in absolute terms (≥ 880px) — a phone even in landscape stays single.
// Visible pages are always fitted whole (the largest scale at which the set
// fits the viewport minus margins): no clipping, no scrolling, navigation is
// horizontal flips only (keys, wheel, edge clicks). Pages render on canvases
// exactly as authored, with pdf.js's invisible text layer on top so text
// stays selectable.
//   Position: a page number, derived from the stored 0..1 progress — restores
//   exactly, at any window size and across spread/single switches.

// Outer margin around the page set: just breathing room off the window edge —
// pages are the protagonist, they take all the space the aspect ratio allows.
const PAGE_MARGIN = 16;
const MAX_PIXEL_RATIO = 2;
const SPREAD_MIN_ASPECT = 1.2;
const SPREAD_MIN_WIDTH = 880;
// Gutter between the two pages of a spread — keep in sync with gap-2 below.
const GUTTER = 8;

// First page of the physical-book spread containing `page`: the cover (1) is
// always alone; pairs are [2,3], [4,5], … so even pages land on the left.
function spreadFirstOf(page: number): number {
  if (page <= 1) return 1;
  return page % 2 === 0 ? page : page - 1;
}

// The visible set starting at `first`: the cover (1) stays alone; physical
// pairs start at [2,3].
function visiblePageNums(first: number, spread: boolean, numPages: number): number[] {
  return spread && first > 1 && first + 1 <= numPages ? [first, first + 1] : [first];
}

// One scale for the whole set: the largest that fits every visible page whole
// (heights share the bound, widths add up plus the gutters).
function fitScale(
  viewports: { width: number; height: number }[],
  availW: number,
  availH: number,
): number {
  let totalW = GUTTER * (viewports.length - 1);
  let maxH = 1;
  for (const viewport of viewports) {
    totalW += viewport.width;
    maxH = Math.max(maxH, viewport.height);
  }
  return Math.min(availW / totalW, availH / maxH);
}

export function PdfReadingView({
  pdfBytes,
  initialProgress = 0,
  panel = null,
  onPanelChange,
  onOutlineChange,
  onProgress,
}: {
  pdfBytes: Uint8Array;
  initialProgress?: number;
  /** Which side panel is open; the view owns its content and jumps. */
  panel?: ReaderPanelMode;
  onPanelChange?: (panel: ReaderPanelMode) => void;
  /** Reports whether the document has an outline (drives the chrome's TOC
      button — only the view knows once the doc has loaded). */
  onOutlineChange?: (hasOutline: boolean) => void;
  /** Fraction read + absolute position (first visible page number, 1-based)
      + how many pages the visible set holds (1, or 2 in a spread). */
  onProgress?: (progress: number, absolute: number, pageCount: number) => void;
}) {
  const { t } = useTranslation();
  const outerRef = useRef<HTMLDivElement>(null);
  const pageHostRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef(0);
  const pageRef = useRef(1);
  const spreadRef = useRef(false);
  const onProgressRef = useLatest(onProgress);
  const onOutlineChangeRef = useLatest(onOutlineChange);
  const numPagesRef = useRef(1);

  const { doc, numPages, restoredPage, failed, outline } = usePdfDocument(
    pdfBytes,
    initialProgress,
  );
  numPagesRef.current = Math.max(1, numPages);

  const [page, setPage] = useState(1);
  const [pageLast, setPageLast] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTokenRef = useRef(0);

  // Restore once the document lands: the stored progress becomes the page.
  useEffect(() => {
    if (restoredPage === 0) return;
    pageRef.current = restoredPage;
    setPage(restoredPage);
    setPageLast(restoredPage);
  }, [restoredPage]);

  // The chrome's TOC button follows the document's outline.
  useEffect(() => {
    if (outline !== null) onOutlineChangeRef.current?.(outline.length > 0);
  }, [outline, onOutlineChangeRef]);

  // Search the text layers, debounced; only the latest query lands. Text
  // extraction is lazy per page, so a broad query can take a moment on a
  // long book — `searching` keeps the panel honest meanwhile.
  useEffect(() => {
    const token = (searchTokenRef.current += 1);
    if (panel !== "search" || !doc || searchQuery.trim() === "") {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchPdf(doc, searchQuery).then((results) => {
        if (token !== searchTokenRef.current) return;
        setSearchResults(results);
        setSearching(false);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [panel, doc, searchQuery]);

  // Render the visible page set (also on resize — the spread/single decision
  // lives here). Rapid navigation is token-guarded: only the latest render
  // lands in the host.
  useEffect(() => {
    const outer = outerRef.current;
    const host = pageHostRef.current;
    if (!outer || !host || !doc) return;

    const render = async () => {
      const token = (renderTokenRef.current += 1);
      try {
        const availW = Math.max(1, outer.clientWidth - 2 * PAGE_MARGIN);
        const availH = Math.max(1, outer.clientHeight - 2 * PAGE_MARGIN);
        const spread =
          availW / availH >= SPREAD_MIN_ASPECT && availW >= SPREAD_MIN_WIDTH;
        spreadRef.current = spread;

        // Normalize the anchor to a spread boundary (31 → 30 shows [30,31]).
        const first = spread ? spreadFirstOf(pageRef.current) : pageRef.current;
        if (first !== pageRef.current) {
          pageRef.current = first;
          setPage(first);
        }
        const nums = visiblePageNums(first, spread, numPagesRef.current);

        const pdfPages = [];
        for (const n of nums) pdfPages.push(await doc.getPage(n));
        const scale = fitScale(
          pdfPages.map((pdfPage) => {
            const base = pdfPage.getViewport({ scale: 1 });
            return { width: base.width, height: base.height };
          }),
          availW,
          availH,
        );
        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

        const renderedPages = [];
        for (const pdfPage of pdfPages) {
          renderedPages.push(await renderPdfPageView(pdfPage, scale, pixelRatio));
        }
        if (token !== renderTokenRef.current || !pageHostRef.current) return;

        const wrappers = renderedPages.map((rendered, index) => {
          const wrap = document.createElement("div");
          wrap.className = "pdf-page";
          wrap.dataset.pageNum = String(nums[index]);
          wrap.style.width = `${rendered.width}px`;
          wrap.style.height = `${rendered.height}px`;
          wrap.replaceChildren(rendered.canvas, rendered.textLayer);
          return wrap;
        });
        pageHostRef.current.replaceChildren(...wrappers);
        // Test seam: the first page number the on-screen canvas actually shows.
        pageHostRef.current.dataset.renderedPage = String(first);
        setPageLast(nums[nums.length - 1]!);
        onProgressRef.current?.(
          numPagesRef.current > 1
            ? (first - 1) / (numPagesRef.current - 1)
            : 1,
          first,
          nums.length,
        );
      } catch {
        // a failed page render leaves the previous page on screen
      }
    };

    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void render());
    };
    void render();
    const ro = new ResizeObserver(schedule);
    ro.observe(outer);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page]);

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
  };

  usePagingInput({
    targetRef: outerRef,
    vertical: false,
    enabled: doc !== null,
    onStep: (dir) => goTo(pageRef.current + stepFor(dir)),
  });

  if (failed) {
    return (
      <div className="grid h-full w-full place-items-center bg-canvas">
        <p className="text-sm text-muted-content">{t("reader.pdfError")}</p>
      </div>
    );
  }

  // Current outline entry = the last one at or before the visible page.
  const currentOutlineIndex = currentIndexBefore(
    (outline ?? []).map((entry) => entry.page),
    page,
  );

  return (
    <div
      ref={outerRef}
      className="grid h-full w-full place-items-center overflow-hidden"
      style={{ background: "var(--reading-bg, var(--ds-surface-canvas))" }}
    >
      <div ref={pageHostRef} className="flex items-center gap-2" data-pdf-page="" />
      {numPages > 0 ? (
        <PageIndicator page={page} pageLast={pageLast} pages={numPages}>
          {page === pageLast ? `${page} / ${numPages}` : `${page}–${pageLast} / ${numPages}`}
        </PageIndicator>
      ) : null}
      {panel === "toc" && outline !== null ? (
        <TocPanel
          entries={outline.map((entry, index) => ({
            label: entry.title,
            page: entry.page,
            current: index === currentOutlineIndex,
          }))}
          onJump={(index) => {
            const entry = outline[index];
            if (entry) goTo(entry.page);
            onPanelChange?.(null);
          }}
          onClose={() => onPanelChange?.(null)}
        />
      ) : null}
      {panel === "search" ? (
        <SearchPanel
          query={searchQuery}
          onQueryChange={setSearchQuery}
          results={searchResults}
          searching={searching}
          onJump={(index) => {
            const result = searchResults[index];
            if (result?.page !== undefined) goTo(result.page);
            onPanelChange?.(null);
          }}
          onClose={() => onPanelChange?.(null)}
        />
      ) : null}
    </div>
  );
}
