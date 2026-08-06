// Section DOM cleanup for the paginated reader: what makes a section blank,
// and the two mutation passes that keep calibre artifacts from fabricating
// phantom pages. Pure DOM utilities — no React, no reader state.

/**
 * A section with no visible payload — an empty spine item, or content the
 * book's own CSS suppresses (e.g. a `.none` title kept for the TOC). It would
 * paginate as a blank page. Text counts when it has a rendered box; an image
 * counts while it loads (valid src) even before its box exists.
 */
export function sectionIsBlank(article: HTMLElement): boolean {
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
export function hideClippedStrips(article: HTMLElement): void {
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
export function trimTrailingSpace(article: HTMLElement): void {
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
