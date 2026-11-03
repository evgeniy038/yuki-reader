// Spread paging geometry, shared by the paged readers (manga, pdf): a spread
// shows on wide screens (aspect ≥ 1.2 and ≥ 880px — manga from 560px, so a
// phone turned sideways reads spreads), one page otherwise, and the visible
// page set is always fitted whole into the viewport minus the outer margin.

// Outer margin around the page set: just breathing room off the window edge —
// pages are the protagonist, they take all the space the aspect ratio allows.
export const PAGE_MARGIN = 16;
export const SPREAD_MIN_ASPECT = 1.2;
export const SPREAD_MIN_WIDTH = 880;
// Manga pages are pictures, not print to squint at: once the stage is
// landscape, a pair costs no page height (the height binds either way) —
// a phone held sideways reads spreads like the book itself.
export const MANGA_SPREAD_MIN_WIDTH = 560;
// A phone-sized stage gives every pixel to the page: no outer margin.
export const COMPACT_STAGE_PX = 600;

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

// First page of the neighbouring visible set in reading order (dir 1 =
// forward), or null past the book's edge. Mirrors useSpreadNav's step: the
// solo cover flips to [2,3], spreads move by two, single pages by one.
export function neighborFirst(
  first: number,
  dir: 1 | -1,
  spread: boolean,
  numPages: number,
  firstPageAsCover: boolean,
): number | null {
  if (dir > 0) {
    const step = !spread ? 1 : firstPageAsCover && first === 1 ? 1 : 2;
    const last = spread ? spreadFirstOf(numPages, firstPageAsCover) : numPages;
    const next = first + step;
    return next <= last ? next : null;
  }
  if (first <= 1) return null;
  return spread ? spreadFirstOf(first - 1, firstPageAsCover) : first - 1;
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
