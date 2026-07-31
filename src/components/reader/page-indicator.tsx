import type { ReactNode } from "react";

// The quiet page chip at the bottom-right of every reader: reading-muted ink,
// no pointer events. The data-* attrs are the test seam (smoke tests read the
// position counters off them) — keep them verbatim.
export function PageIndicator({
  page,
  pages,
  pageLast,
  children,
}: {
  page: number;
  pages: number;
  /** Last visible page (PDF spread); absent when the set is one page. */
  pageLast?: number;
  children: ReactNode;
}) {
  return (
    <div
      data-page-indicator=""
      data-page={page}
      data-page-last={pageLast}
      data-pages={pages}
      className="pointer-events-none fixed bottom-3 right-4 z-20 text-xs"
      style={{ color: "var(--reading-muted, var(--ds-content-muted))" }}
    >
      {children}
    </div>
  );
}
