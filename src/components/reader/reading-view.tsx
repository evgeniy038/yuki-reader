import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "@/core/library";
import type { Chapter, EpubResource, TocEntry } from "@/core/reading";
import { scopeBookCss } from "@/core/book-css";
import type { ReadingStats } from "@/core/reading-stats";
import { useLatest } from "@/lib/use-latest";
import { buildArticle, type ArticleBuild } from "./book-html";
import { useSectionPager, type Landing } from "./use-section-pager";
import { usePagingInput } from "./use-paging-input";
import { PageIndicator } from "./page-indicator";
import { ReadingPanels } from "./reading-panels";
import { type ReaderPanelMode } from "./reader-panel";

// Paginated reader: multi-column fragmentation over ONE section at a time.
// Laying out the whole book at once costs seconds on big novels (the browser
// fragments everything), so only the current spine section lives in the DOM —
// the reference reader's model. The browser fragments the section into column
// boxes via CSS multi-column + column-fill:auto, so page breaks always land
// on line boundaries — glyphs are never sliced at page edges, at any zoom.
//   Vertical (ja): writing-mode vertical-rl; column boxes are one viewport
// tall and stack downward along the inline axis → paging is scrollTop.
//   Horizontal: column boxes are one page wide and stack rightward → paging
// is scrollLeft. The page is a single column; on a wide window it becomes a
// two-page SPREAD (two columns, each capped at a book-like measure), like
// the PDF reader — never a full-bleed wall of text.
// Page step = viewport + gap. Every page aligns because the last column box
// has no trailing gap, so max scroll = (pages - 1) × step exactly — a spread
// pads an odd column tail with one blank column to keep that invariant.
// Margins live OUTSIDE the page box (the scroll box is inset from the screen);
// padding goes only across the page axis (padding-block), never along it —
// padding along the fragmented axis would break the column pitch.
//
// The reading position is GLOBAL across sections: a character count over the
// whole book (each section knows its char offset from the build pass), so
// progress, the bookmark and stats keep their meaning without a global layout.

export function ReadingView({
  chapters,
  language,
  fontSize,
  pageMargin,
  resources,
  bookCss,
  initialProgress,
  toc,
  panel,
  onPanelChange,
  onProgress,
}: {
  chapters: Chapter[];
  language?: Language;
  fontSize: number;
  /** Page margins, px: head/foot inset + cross-axis padding of the page box. */
  pageMargin: number;
  resources?: EpubResource[];
  bookCss?: string;
  initialProgress: number;
  /** Table of contents (chapter ids → section jump targets). */
  toc?: TocEntry[];
  /** Which side panel is open; the view owns its content and jumps. */
  panel: ReaderPanelMode;
  onPanelChange?: (panel: ReaderPanelMode) => void;
  /** Fraction read + absolute position (countable chars) + countable chars
      on the current page. Fires on every page turn and every relayout — the
      consumer debounces these into a dwell. */
  onProgress?: (progress: number, absolute: number, pageChars: number) => void;
}) {
  const { t } = useTranslation();
  const vertical = language === "ja";
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  /** Trailing blank-column element for spread parity (see measure). */
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const onProgressRef = useLatest(onProgress);
  const verticalRef = useLatest(vertical);
  const stepRef = useRef(0);
  const pageCountRef = useRef(1);
  const pageRef = useRef(0);
  /** Char stats of the rendered section (null before the first render). */
  const statsRef = useRef<ReadingStats | null>(null);
  /** The built book: sections with html + global char offsets, search index. */
  const modelRef = useRef<ArticleBuild | null>(null);
  /** Index of the section currently in the DOM (-1 = nothing rendered yet). */
  const currentSectionRef = useRef(-1);
  // Anchor: GLOBAL character index the reader is at (top of the current
  // page). Updated ONLY on user navigation — remeasures re-anchor to it after
  // a relayout, so a resize round-trip returns to the exact same character.
  const charPosRef = useRef(0);
  // Restore-on-open: the stored 0..1 progress becomes the character anchor on
  // the first measure. Re-armed by every rebuild (see the chapters effect), so
  // StrictMode's dev double-mount restores twice and still lands on the page.
  const restoredRef = useRef(false);
  /** Effect-scope section renderer, exposed to the input handlers below. */
  const renderSectionRef = useRef<
    ((index: number, landing: Landing) => void) | null
  >(null);

  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [exploredCount, setExploredCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [model, setModel] = useState<ArticleBuild | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Inject the book's scoped CSS into <head> (once per book); remove on close.
  // A LAYOUT effect so the styles are in force before the first section render
  // below — content the book hides (e.g. `.none`) must already be hidden when
  // the blank-section skip and pagination measure it.
  const scopedCss = useMemo(() => scopeBookCss(bookCss ?? ""), [bookCss]);
  useLayoutEffect(() => {
    if (!scopedCss) return;
    const el = document.createElement("style");
    el.setAttribute("data-yuki-book", "");
    el.textContent = scopedCss;
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [scopedCss]);

  // Build the section model (all chapters parsed once, char offsets and the
  // search index included); the section RENDER happens in the measure effect
  // below — it owns geometry. Rebuild resets the anchor and re-arms restore.
  useLayoutEffect(() => {
    const build = buildArticle(chapters, resources);
    modelRef.current = build;
    currentSectionRef.current = -1;
    pageRef.current = 0;
    charPosRef.current = 0;
    restoredRef.current = false;
    setModel(build);

    let inlineStyle: HTMLStyleElement | null = null;
    if (build.inlineCss) {
      inlineStyle = document.createElement("style");
      inlineStyle.setAttribute("data-yuki-book-inline", "");
      inlineStyle.textContent = build.inlineCss;
      document.head.appendChild(inlineStyle);
    }
    return () => {
      build.urls.forEach((url) => URL.revokeObjectURL(url));
      inlineStyle?.remove();
    };
  }, [chapters, resources]);

  const { currentSection, sectionForChar, reportProgress, scrollToPage } =
    useSectionPager({
      chapters,
      resources,
      language,
      fontSize,
      pageMargin,
      initialProgress,
      outerRef,
      scrollRef,
      contentRef,
      articleRef,
      spacerRef,
      onProgressRef,
      verticalRef,
      stepRef,
      pageCountRef,
      pageRef,
      statsRef,
      modelRef,
      currentSectionRef,
      charPosRef,
      restoredRef,
      renderSectionRef,
      setPage,
      setPageCount,
      setExploredCount,
      setTotalCount,
    });

  const goTo = (index: number) => {
    const count = pageCountRef.current;
    const current = currentSectionRef.current;
    const sectionCount = modelRef.current?.sections.length ?? 0;
    // Section boundary: cross or stay at the book's edge.
    if (index < 0) {
      if (current > 0) renderSectionRef.current?.(current - 1, { kind: "end" });
      return;
    }
    if (index >= count) {
      if (current < sectionCount - 1)
        renderSectionRef.current?.(current + 1, { kind: "start" });
      return;
    }
    pageRef.current = index;
    setPage(index);
    scrollToPage(index);
    charPosRef.current =
      (currentSection()?.offset ?? 0) + (statsRef.current?.explored(index) ?? 0);
    reportProgress(index);
  };

  // Jump to a global character offset (search hit): the anchor follows, so a
  // later resize keeps the same spot. The panel closes — you read now.
  const jumpToChar = (offset: number) => {
    renderSectionRef.current?.(sectionForChar(offset), {
      kind: "char",
      char: offset,
    });
    onPanelChange?.(null);
  };

  // Jump to a percentage of the whole book (indicator chip): the percent maps
  // to a global char offset, then reuses the search-hit jump above.
  const jumpToPercent = (percent: number) => {
    const total = modelRef.current?.total ?? totalCount;
    if (!total) return;
    const clamped = Math.min(100, Math.max(0, percent));
    jumpToChar(Math.round((clamped / 100) * Math.max(total - 1, 0)));
  };

  // Jump to a section's start (TOC entry — identified by section, not char,
  // so zero-width sections like a cover page are reachable).
  const jumpToSection = (index: number) => {
    renderSectionRef.current?.(index, { kind: "start" });
    onPanelChange?.(null);
  };

  const progressPercent =
    totalCount > 0
      ? Number(((exploredCount / totalCount) * 100).toFixed(1))
      : 0;

  // Novel pages move with wheel/keyboard input only; clicks stay available for
  // text selection and dictionary lookup.
  usePagingInput({
    targetRef: outerRef,
    vertical,
    enabled: chapters.length > 0,
    click: false,
    keyboard: "arrows",
    onStep: (dir) => goTo(pageRef.current + dir),
  });

  return (
    <div
      ref={outerRef}
      className="relative flex h-full w-full"
      style={{ background: "var(--reading-bg, var(--ds-surface-canvas))" }}
    >
      <div ref={scrollRef} className="m-auto overflow-hidden">
        <div ref={contentRef} className="reading" data-vertical={vertical ? "true" : undefined}>
          <article ref={articleRef} className="book-content" />
        </div>
      </div>
      <PageIndicator
        page={page + 1}
        pages={pageCount}
        jumpMin={0}
        jumpMax={100}
        jumpStep={0.1}
        jumpValue={progressPercent}
        jumpLabel={t("reader.jumpPercent")}
        jumpSubmitLabel={t("reader.jump")}
        onJump={jumpToPercent}
      >
        {totalCount > 0
          ? `${exploredCount} / ${totalCount} ${progressPercent.toFixed(1)}%`
          : `${page + 1} / ${pageCount}`}
      </PageIndicator>
      <ReadingPanels
        panel={panel}
        toc={toc}
        model={model}
        exploredCount={exploredCount}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onJumpSection={jumpToSection}
        onJumpChar={jumpToChar}
        onClose={() => onPanelChange?.(null)}
      />
    </div>
  );
}
