import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
//   Horizontal: column boxes are one viewport wide → paging is scrollLeft.
// Page step = viewport + gap. Every page aligns because the last column box
// has no trailing gap, so max scroll = (pages - 1) × step exactly.
// Margins live OUTSIDE the page box (the scroll box is inset from the screen);
// padding goes only across the page axis (padding-block), never along it —
// padding along the fragmented axis would break the column pitch.
//
// The reading position is GLOBAL across sections: a character count over the
// whole book (each section knows its char offset from the build pass), so
// progress, the bookmark and stats keep their meaning without a global layout.

const GAP = 40;

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
    return el instanceof HTMLImageElement && !el.complete && !!el.currentSrc;
  });
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
  const vertical = language === "ja";
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
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
      // Page margins live OUTSIDE the page box: the scroll box is
      // inset from the screen, column boxes fill it exactly, so the pitch
      // along the fragmented axis stays intact. Vertical head/foot margins
      // come from this inset; side margins from padding-block (horizontal
      // gets top/bottom from padding-block instead).
      const w = aw;
      const h = isVertical ? ah - 2 * pageMargin : ah;
      if (!w || !h || w <= 0 || h <= 0) return;
      scrollEl.style.width = `${w}px`;
      scrollEl.style.height = `${h}px`;

      contentEl.lang = isVertical ? "ja" : "en";
      contentEl.style.writingMode = isVertical ? "vertical-rl" : "horizontal-tb";
      contentEl.style.columnGap = `${GAP}px`;
      contentEl.style.columnFill = "auto";
      contentEl.style.paddingBlock = `${pageMargin}px`;
      contentEl.style.paddingInline = "0";
      contentEl.style.setProperty("--reading-page-height", `${h}px`);

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
        contentEl.style.columnWidth = `${w}px`;
      }
      void contentEl.offsetHeight; // reflow

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

  usePagingInput({
    targetRef: scrollRef,
    vertical,
    enabled: chapters.length > 0,
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
      <PageIndicator page={page + 1} pages={pageCount}>
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
