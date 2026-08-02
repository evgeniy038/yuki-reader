import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "@/core/library";
import type { Chapter, EpubResource, TocEntry } from "@/core/reading";
import { scopeBookCss } from "@/core/book-css";
import { ReadingStats } from "@/core/reading-stats";
import { useLatest } from "@/lib/use-latest";
import { buildArticle, type ArticleBuild } from "./book-html";
import {
  buildSearchResults,
  buildTocEntries,
  currentIndexBefore,
} from "./panels-data";
import { usePagingInput } from "./use-paging-input";
import { PageIndicator } from "./page-indicator";
import {
  SearchPanel,
  TocPanel,
  type ReaderPanelMode,
} from "./reader-panel";

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

const GAP = 40;

/** Horizontal line measure limits, in em of the reading font size. 26em is
    the narrowest column that still reads well (a spread needs at least that
    per page); 40em is the widest — about the vertical page's natural line
    length, ~80 latin chars. */
const MEASURE_MIN_EM = 26;
const MEASURE_MAX_EM = 40;

/** Where to land after a section (re)render or re-measure. */
type Landing =
  | { kind: "start" } // first page of the section (forward crossing)
  | { kind: "end" } // last page (backward crossing)
  | { kind: "char"; char: number } // page holding this GLOBAL char (jump/restore)
  | { kind: "keep" }; // re-anchor to the current char position (resize/zoom)

/**
 * A section with no visible payload — an empty spine item, or content the
 * book's own CSS suppresses (e.g. a `.none` title kept for the TOC). It would
 * paginate as a blank page. Text counts when it has a rendered box; an image
 * counts while it loads (valid src) even before its box exists.
 */
function sectionIsBlank(article: HTMLElement): boolean {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const current = node;
    node = walker.nextNode();
    if (!(current.nodeValue ?? "").trim()) continue;
    const el = current.parentElement;
    if (!el || el.closest("rt") || el.closest("rp")) continue;
    const range = document.createRange();
    range.selectNodeContents(current);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return false;
  }
  return !Array.from(
    article.querySelectorAll("img, image, video, svg"),
  ).some((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    // The declared src is the truth: currentSrc is still empty right after
    // the innerHTML swap, before the fetch has even started.
    return (
      el instanceof HTMLImageElement &&
      !el.complete &&
      !!(el.currentSrc || el.getAttribute("src"))
    );
  });
}

// Visually-hidden accessibility strips (calibre: a 0.128%-wide overflow:hidden
// div holding alt text for screen readers) paginate as px-wide MONOLITHS
// taller than the page: overflow makes them unfragmentable, so they overflow
// below the column box, inflate the section's scroll size and add phantom
// pages. A px-wide element clipped by overflow can display nothing by
// construction — hide it outright. Runs before ReadingStats so the strip's
// text never reaches the char→page mapping. One layout pass, mutations
// batched after it (no interleaved reflows).
const STRIP_REPLACED = new Set([
  "IMG",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "INPUT",
]);
function hideClippedStrips(article: HTMLElement): void {
  const hide: HTMLElement[] = [];
  for (const el of article.querySelectorAll("*")) {
    if (!(el instanceof HTMLElement) || STRIP_REPLACED.has(el.tagName)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 4 || rect.height < 1) continue;
    const { overflowX, overflowY } = getComputedStyle(el);
    const clipped = (overflowX === "hidden" || overflowX === "clip") &&
      (overflowY === "hidden" || overflowY === "clip");
    if (clipped) hide.push(el);
  }
  for (const el of hide) el.style.display = "none";
}

// The section's trailing edge spacing (calibre wrappers carry padding-bottom,
// which fragmentation does NOT truncate at column breaks — unlike margins):
// when it doesn't fit the last content column it spills into a phantom blank
// column, and spread parity then pads ANOTHER one. Space after the final
// content has no in-flow meaning — zero it along the last-visible-child chain
// (hidden strips skipped), inline so book CSS can't reassert it.
function trimTrailingSpace(article: HTMLElement): void {
  let el: Element | null = article;
  for (;;) {
    let child: Element | null = el.lastElementChild;
    while (child && getComputedStyle(child).display === "none")
      child = child.previousElementSibling;
    if (!child || !(child instanceof HTMLElement) || STRIP_REPLACED.has(child.tagName))
      return;
    child.style.paddingBlockEnd = "0";
    child.style.marginBlockEnd = "0";
    el = child;
  }
}

export function ReadingView({
  chapters,
  language,
  fontSize,
  pageMargin = 40,
  resources,
  bookCss,
  initialProgress = 0,
  toc,
  panel = null,
  onPanelChange,
  onProgress,
}: {
  chapters: Chapter[];
  language?: Language;
  fontSize: number;
  /** Page margins, px: head/foot inset + cross-axis padding of the page box. */
  pageMargin?: number;
  resources?: EpubResource[];
  bookCss?: string;
  initialProgress?: number;
  /** Table of contents (chapter ids → section jump targets). */
  toc?: TocEntry[];
  /** Which side panel is open; the view owns its content and jumps. */
  panel?: ReaderPanelMode;
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
  const [pageTurnHover, setPageTurnHover] = useState(false);

  const currentSection = () =>
    modelRef.current?.sections[currentSectionRef.current];

  // The section holding a global char: the last one with offset <= char
  // (zero-width sections share offsets with their successor — the char
  // belongs to the successor).
  const sectionForChar = (char: number): number => {
    const sections = modelRef.current?.sections ?? [];
    let lo = 0;
    let hi = sections.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((sections[mid]?.offset ?? 0) <= char) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  // Report the position for the section-local page `index`: explored/total
  // are GLOBAL (section offset + local explored) for the indicator and the
  // consumer (bookmark dwell + per-page stats).
  const reportProgress = (index: number) => {
    const count = pageCountRef.current;
    const stats = statsRef.current;
    const localExplored = stats?.explored(index) ?? 0;
    const explored = (currentSection()?.offset ?? 0) + localExplored;
    const total = modelRef.current?.total ?? 0;
    const pageEnd = stats
      ? index + 1 < count
        ? stats.explored(index + 1)
        : stats.total
      : 0;
    setExploredCount(explored);
    setTotalCount(total);
    if (count > 0)
      onProgressRef.current?.(
        total > 0 ? explored / total : index / (count - 1 || 1),
        explored,
        pageEnd - localExplored,
      );
  };

  const scrollToPage = (index: number) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const pos = index * stepRef.current;
    if (verticalRef.current) scrollEl.scrollTo({ top: pos, behavior: "auto" });
    else scrollEl.scrollTo({ left: pos, behavior: "auto" });
  };

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

  // Geometry + section rendering, all BEFORE paint so the first frame already
  // shows the landed page.
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl || chapters.length === 0) return;

    // Apply geometry + measure the rendered section: page pitch, page count,
    // and the char→page binding. Cheap — one section, never the whole book.
    const measure = () => {
      const outerEl = outerRef.current;
      if (!outerEl) return;
      const stats = statsRef.current;
      const aw = outerEl.clientWidth;
      const ah = outerEl.clientHeight;
      const isVertical = verticalRef.current;
      // The spread tail spacer is re-decided on every pass — start hidden so
      // the measurement below reflects real content.
      const spacer = spacerRef.current;
      if (spacer) spacer.style.display = "";
      // Page margins live OUTSIDE the page box: the scroll box is inset from
      // the screen along the fragmented axis (m-auto centers it) and padded
      // across it (padding-block) — padding along the fragmented axis would
      // break the column pitch. Vertical head/foot margins come from the
      // inset, side margins from padding-block; horizontal is mirrored —
      // top/bottom from padding-block, sides from the inset.
      // On a wide window the horizontal page becomes a two-page SPREAD: two
      // columns of a book-like measure (like the PDF reader), centered with
      // margins at least pageMargin wide. Below the spread threshold — one
      // centered column, never wider than a readable measure, never narrower
      // than the window minus margins.
      const h = isVertical ? ah - 2 * pageMargin : ah;
      let w = aw;
      let column = 0;
      let spread = false;
      if (!isVertical) {
        const half = (aw - 2 * pageMargin - GAP) / 2;
        spread = half >= MEASURE_MIN_EM * fontSize;
        column = spread
          ? Math.min(half, MEASURE_MAX_EM * fontSize)
          : Math.min(aw - 2 * pageMargin, MEASURE_MAX_EM * fontSize);
        w = spread ? 2 * column + GAP : column;
      }
      if (!w || !h || w <= 0 || h <= 0) return;
      scrollEl.style.width = `${w}px`;
      scrollEl.style.height = `${h}px`;

      contentEl.lang = isVertical ? "ja" : "en";
      contentEl.style.writingMode = isVertical ? "vertical-rl" : "horizontal-tb";
      contentEl.style.columnGap = `${GAP}px`;
      contentEl.style.columnFill = "auto";
      contentEl.style.paddingBlock = `${pageMargin}px`;
      contentEl.style.paddingInline = "0";
      // Illustration limit = the column CONTENT height: vertical's inset is
      // already subtracted above, horizontal's padding-block eats into its
      // box — a full-page image sized to the box would overflow the column.
      contentEl.style.setProperty(
        "--reading-page-height",
        `${isVertical ? h : h - 2 * pageMargin}px`,
      );

      if (isVertical) {
        // vertical-rl: one column-count makes column boxes stack downward
        // (inline axis); column-width maps to the box height physically.
        contentEl.style.width = "100%";
        contentEl.style.height = "auto";
        contentEl.style.columnCount = "1";
        contentEl.style.columnWidth = `${h}px`;
      } else {
        contentEl.style.width = "";
        contentEl.style.height = `${h}px`;
        contentEl.style.columnCount = "";
        contentEl.style.columnWidth = `${column}px`;
      }
      void contentEl.offsetHeight; // reflow

      // A spread paginates exactly only into an even number of columns: an
      // odd tail would clamp the last spread one column short and repeat a
      // page. Pad it with a blank trailing column (the spacer starts a fresh
      // column by CSS), keeping max scroll = (pages - 1) × step.
      if (spread && spacer) {
        const cols = Math.round((scrollEl.scrollWidth + GAP) / (column + GAP));
        if (cols % 2 === 1) {
          spacer.style.display = "block";
          void contentEl.offsetHeight; // reflow: the spacer column joins scrollWidth
        }
      }

      const viewport = isVertical ? h : w;
      const scrollSize = isVertical ? scrollEl.scrollHeight : scrollEl.scrollWidth;
      const step = viewport + GAP;
      const count = Math.max(1, Math.ceil(scrollSize / step));
      stepRef.current = step;
      pageCountRef.current = count;
      setPageCount(count);

      stats?.bind(scrollEl, step, isVertical);
    };

    // Land on a page after a (re)measure. "keep" re-anchors to the global char
    // anchor (resize/zoom round-trips) and never moves it. A "char" landing
    // keeps the exact requested character as the anchor so later re-measures
    // (images loading in) re-land on it instead of a page top computed from
    // an unfinished layout.
    const land = (landing: Landing) => {
      const stats = statsRef.current;
      const count = pageCountRef.current;
      const section = currentSection();
      let target: number;
      if (landing.kind === "end") target = count - 1;
      else if (landing.kind === "start") target = 0;
      else if (stats) {
        const char = landing.kind === "char" ? landing.char : charPosRef.current;
        target = Math.min(
          stats.pageForChar(char - (section?.offset ?? 0)),
          count - 1,
        );
      } else {
        target = Math.min(pageRef.current, count - 1);
      }
      target = Math.max(0, target);
      pageRef.current = target;
      setPage(target);
      scrollToPage(target);
      if (landing.kind === "char") {
        charPosRef.current = landing.char;
      } else if (landing.kind === "start") {
        charPosRef.current = section?.offset ?? 0;
      } else if (landing.kind === "end") {
        charPosRef.current =
          (section?.offset ?? 0) + (stats?.explored(count - 1) ?? 0);
      }
      reportProgress(target);
    };

    // Swap the DOM to section `index` (if not already there), rebuild its char
    // stats, re-measure and land. The only place section content is rendered.
    // Blank sections are skipped, walking in the landing's direction — they
    // would otherwise show up as empty pages in the middle of the book.
    const renderSection = (index: number, landing: Landing) => {
      const current = modelRef.current;
      const article = articleRef.current;
      if (!current || !article || current.sections.length === 0) return;
      const clamped = Math.max(0, Math.min(current.sections.length - 1, index));
      if (currentSectionRef.current !== clamped) {
        article.innerHTML = current.sections[clamped]!.html;
        hideClippedStrips(article);
        // Trailing phantom columns are a horizontal-book problem (calibre
        // wrappers); the vertical path paginates as authored — untouched.
        if (!verticalRef.current) trimTrailingSpace(article);
        // The spread tail spacer lives at the flow's end; measure() flips it
        // on when the section ends on an odd column (spread parity).
        let spacer = spacerRef.current;
        if (!spacer) {
          spacer = document.createElement("div");
          spacer.className = "page-spacer";
          spacer.setAttribute("aria-hidden", "true");
          spacerRef.current = spacer;
        }
        article.appendChild(spacer);
        statsRef.current = new ReadingStats(article);
        currentSectionRef.current = clamped;
      }
      measure();
      if (sectionIsBlank(article)) {
        const forward = landing.kind !== "end";
        const next = clamped + (forward ? 1 : -1);
        if (next >= 0 && next < current.sections.length) {
          renderSection(
            next,
            landing.kind === "char"
              ? { kind: forward ? "start" : "end" }
              : landing,
          );
          return;
        }
      }
      land(landing);
    };
    renderSectionRef.current = renderSection;

    // First measure after a (re)build: render the section holding the stored
    // progress and land on its character. Later measures only re-anchor.
    const remeasure = () => {
      const current = modelRef.current;
      if (!restoredRef.current && current) {
        restoredRef.current = true;
        if (current.total > 0) {
          charPosRef.current = Math.round(initialProgress * current.total);
          renderSection(sectionForChar(charPosRef.current), {
            kind: "char",
            char: charPosRef.current,
          });
          return;
        }
      }
      if (currentSectionRef.current === -1) {
        renderSection(0, { kind: "start" });
        return;
      }
      measure();
      land({ kind: "keep" });
    };

    let raf = 0;
    let fsTimer = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(remeasure);
    };
    const onFullscreen = () => {
      schedule();
      window.clearTimeout(fsTimer);
      fsTimer = window.setTimeout(remeasure, 250);
    };
    remeasure();
    const ro = new ResizeObserver(schedule);
    if (outerRef.current) ro.observe(outerRef.current);
    // The section box too: images finishing resize the flow — a cheap
    // re-measure absorbs it instead of drifting the page count.
    ro.observe(contentEl);
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fsTimer);
      ro.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreen);
      document.removeEventListener("webkitfullscreenchange", onFullscreen);
    };
  }, [language, fontSize, pageMargin, chapters, resources]);

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

  const tocEntries = useMemo(() => {
    if (!toc || !model) return [];
    const sectionById = new Map(model.sections.map((s, i) => [s.id, i] as const));
    return buildTocEntries(toc, sectionById, model);
  }, [toc, model]);
  const currentTocIndex = currentIndexBefore(
    tocEntries.map((entry) => entry.offset),
    exploredCount,
  );
  const searchResults = useMemo(
    () => (model ? buildSearchResults(model.index, searchQuery, model.total) : []),
    [searchQuery, model],
  );

  // Click-to-turn on the full reader stage: left/right halves page the book,
  // including the breathing room above and below the page. Text keeps its
  // normal cursor for copying; the pointer appears in the safe empty surface.
  usePagingInput({
    targetRef: outerRef,
    vertical,
    enabled: chapters.length > 0,
    clickMode: "halves",
    onStep: (dir) => goTo(pageRef.current + dir),
  });

  return (
    <div
      ref={outerRef}
      className={`relative flex h-full w-full ${pageTurnHover ? "cursor-pointer" : ""}`}
      style={{ background: "var(--reading-bg, var(--ds-surface-canvas))" }}
      onMouseMove={(event) => {
        const target = event.target as Element | null;
        setPageTurnHover(!target?.closest(".book-content"));
      }}
      onMouseLeave={() => setPageTurnHover(false)}
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
        jumpValue={totalCount > 0 ? (exploredCount / totalCount) * 100 : 0}
        jumpLabel={t("reader.jumpPercent")}
        jumpSubmitLabel={t("reader.jump")}
        onJump={jumpToPercent}
      >
        {totalCount > 0
          ? `${exploredCount} / ${totalCount} ${((exploredCount / totalCount) * 100).toFixed(1)}%`
          : `${page + 1} / ${pageCount}`}
      </PageIndicator>
      {panel === "toc" ? (
        <TocPanel
          entries={tocEntries.map((entry, index) => ({
            label: entry.label,
            progress: entry.progress,
            current: index === currentTocIndex,
          }))}
          onJump={(index) => jumpToSection(tocEntries[index]!.section)}
          onClose={() => onPanelChange?.(null)}
        />
      ) : null}
      {panel === "search" ? (
        <SearchPanel
          query={searchQuery}
          onQueryChange={setSearchQuery}
          results={searchResults}
          searching={false}
          onJump={(index) => jumpToChar(searchResults[index]!.offset)}
          onClose={() => onPanelChange?.(null)}
        />
      ) : null}
    </div>
  );
}
