import { useLayoutEffect, type Dispatch, type SetStateAction } from "react";
import type { Chapter, EpubResource } from "@/core/reading";
import type { Language } from "@/core/library";
import { ReadingStats } from "@/core/reading-stats";
import type { ArticleBuild } from "./book-html";
import {
  hideClippedStrips,
  sectionIsBlank,
  trimTrailingSpace,
} from "./section-cleanup";

const GAP = 40;

/** Horizontal line measure limits, in em of the reading font size. 26em is
    the narrowest column that still reads well (a spread needs at least that
    per page); 40em is the widest — about the vertical page's natural line
    length, ~80 latin chars. */
const MEASURE_MIN_EM = 26;
const MEASURE_MAX_EM = 40;

/** Where to land after a section (re)render or re-measure. */
export type Landing =
  | { kind: "start" } // first page of the section (forward crossing)
  | { kind: "end" } // last page (backward crossing)
  | { kind: "char"; char: number } // page holding this GLOBAL char (jump/restore)
  | { kind: "keep" }; // re-anchor to the current char position (resize/zoom)

type OnProgress =
  | ((progress: number, absolute: number, pageChars: number) => void)
  | undefined;

// Geometry + section rendering for the paginated reader, all in ONE layout
// effect (before paint, so the first frame already shows the landed page).
// The view owns the refs and the state; this hook owns the measure/render/
// land machinery and hands the small helpers back for the navigation
// functions below it. Do not reorder the effect's internals: the reflow
// points (`void contentEl.offsetHeight`) and the observer wiring are load-
// bearing.
export function useSectionPager({
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
}: {
  chapters: Chapter[];
  resources?: EpubResource[];
  language?: Language;
  fontSize: number;
  pageMargin: number;
  initialProgress: number;
  outerRef: { current: HTMLDivElement | null };
  scrollRef: { current: HTMLDivElement | null };
  contentRef: { current: HTMLDivElement | null };
  articleRef: { current: HTMLElement | null };
  spacerRef: { current: HTMLDivElement | null };
  onProgressRef: { current: OnProgress };
  verticalRef: { current: boolean };
  stepRef: { current: number };
  pageCountRef: { current: number };
  pageRef: { current: number };
  statsRef: { current: ReadingStats | null };
  modelRef: { current: ArticleBuild | null };
  currentSectionRef: { current: number };
  charPosRef: { current: number };
  restoredRef: { current: boolean };
  renderSectionRef: {
    current: ((index: number, landing: Landing) => void) | null;
  };
  setPage: Dispatch<SetStateAction<number>>;
  setPageCount: Dispatch<SetStateAction<number>>;
  setExploredCount: Dispatch<SetStateAction<number>>;
  setTotalCount: Dispatch<SetStateAction<number>>;
}) {
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

  return { currentSection, sectionForChar, reportProgress, scrollToPage };
}
