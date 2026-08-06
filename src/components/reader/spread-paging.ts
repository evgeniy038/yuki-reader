// Spread paging geometry, shared by the paged readers (manga, pdf): a spread
// shows on wide screens (aspect ≥ 1.2 and ≥ 880px), one page otherwise, and
// the visible page set is always fitted whole into the viewport minus the
// outer margin.

// Outer margin around the page set: just breathing room off the window edge —
// pages are the protagonist, they take all the space the aspect ratio allows.
export const PAGE_MARGIN = 16;
export const SPREAD_MIN_ASPECT = 1.2;
export const SPREAD_MIN_WIDTH = 880;

// First page of the physical-book spread containing `page`. With
// `firstPageAsCover` the cover (1) is always alone and pairs are [2,3],
// [4,5], … so even pages land on the left; without it pairs are [1,2],
// [3,4], …
export function spreadFirstOf(page: number, firstPageAsCover: boolean): number {
  if (firstPageAsCover) {
    if (page <= 1) return 1;
    return page % 2 === 0 ? page : page - 1;
  }
  return page % 2 === 1 ? page : page - 1;
}

// The visible set starting at `first`: a pair only when a spread is on, the
// next page exists, and the cover rule allows pairing.
export function visibleNums(
  first: number,
  spread: boolean,
  numPages: number,
  firstPageAsCover: boolean,
): number[] {
  const canPair =
    spread && first + 1 <= numPages && (!firstPageAsCover || first > 1);
  return canPair ? [first, first + 1] : [first];
}

// One scale for the whole set: the largest that fits every visible page whole
// (heights share the bound, widths add up plus the gutters).
export function fitScale(
  pages: { width: number; height: number }[],
  availW: number,
  availH: number,
  gutter: number,
): number {
  let totalW = gutter * (pages.length - 1);
  let maxH = 1;
  for (const page of pages) {
    totalW += page.width;
    maxH = Math.max(maxH, page.height);
  }
  return Math.min(availW / totalW, availH / maxH);
}

// Fraction read for a 1-based first visible page (a one-page book is done).
export function spreadProgress(first: number, numPages: number): number {
  return numPages > 1 ? (first - 1) / (numPages - 1) : 1;
}
