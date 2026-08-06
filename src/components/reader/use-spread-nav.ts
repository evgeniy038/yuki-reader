import { useRef } from "react";
import { spreadFirstOf } from "./spread-paging";

// Shared spread/single navigation for the paged readers (manga, pdf): one
// page per flip in single mode; in spread mode the cover flips to the first
// pair, then spreads advance by two. `goTo` clamps to the last spread start,
// normalizes to a spread boundary, and reports the landing page through
// `onNavigate` (the caller applies it to state — and, for manga, resets the
// zoom/pan). The refs come back out: the views also drive them from their
// load/render effects.
export function useSpreadNav({
  firstPageAsCover,
  onNavigate,
}: {
  firstPageAsCover: boolean;
  onNavigate: (page: number) => void;
}) {
  const pageRef = useRef(1);
  const spreadRef = useRef(false);
  const numPagesRef = useRef(1);

  // Navigation step: one page in single mode; in spread mode the cover flips
  // to 2, then spreads advance by two.
  const stepFor = (dir: 1 | -1): number => {
    if (!spreadRef.current) return dir;
    if (firstPageAsCover && pageRef.current === 1 && dir > 0) return 1;
    return 2 * dir;
  };

  const goTo = (index: number) => {
    const count = numPagesRef.current;
    const max = spreadRef.current
      ? spreadFirstOf(count, firstPageAsCover)
      : count;
    let target = Math.max(1, Math.min(max, index));
    if (spreadRef.current && target > 1) {
      target = spreadFirstOf(target, firstPageAsCover);
    }
    if (target === pageRef.current) return;
    pageRef.current = target;
    onNavigate(target);
  };

  return { pageRef, spreadRef, numPagesRef, stepFor, goTo };
}
