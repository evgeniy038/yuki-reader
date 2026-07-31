import type { TocEntry } from "@/core/reading";
import type { SearchResultItem } from "./reader-panel";

// In-book search: stop after this many matches (a common kanji matches
// thousands) and show this many context chars around each match.
const SEARCH_MAX_RESULTS = 50;
const SEARCH_CONTEXT = 18;

/** TOC entry resolved against the built book: target section, global char
    offset and progress (share of the book). */
interface TocEntryView {
  label: string;
  /** Index of the spine section the entry jumps to. */
  section: number;
  /** Global char offset where the entry's section starts. */
  offset: number;
  /** Share of the book before the entry (0..1) — what the panel shows. */
  progress: number;
}

/** A search hit with display context, its jump target (char offset) and
    progress (share of the book). */
type SearchResultView = SearchResultItem & { offset: number };

// TOC entries with their target sections/offsets; sections the spine doesn't
// contain (stray NCX targets) drop out. Page numbers don't exist without a
// global layout — the per-section reader shows progress instead.
export function buildTocEntries(
  toc: TocEntry[],
  sectionById: Map<string, number>,
  book: { sections: { offset: number }[]; total: number },
): TocEntryView[] {
  return toc.flatMap((entry) => {
    const section = sectionById.get(entry.chapterId);
    if (section === undefined) return [];
    const offset = book.sections[section]?.offset ?? 0;
    return [
      {
        label: entry.label,
        section,
        offset,
        progress: book.total > 0 ? offset / book.total : 0,
      },
    ];
  });
}

// All matches of the query across the book-wide index, capped, each with a
// little context around the hit and the progress it lands on.
export function buildSearchResults(
  index: { text: string; offset: number }[],
  query: string,
  total: number,
): SearchResultView[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: SearchResultView[] = [];
  for (const { text, offset } of index) {
    const haystack = text.toLowerCase();
    let from = 0;
    while (out.length < SEARCH_MAX_RESULTS) {
      const at = haystack.indexOf(q, from);
      if (at === -1) break;
      out.push({
        before: text.slice(Math.max(0, at - SEARCH_CONTEXT), at),
        match: text.slice(at, at + q.length),
        after: text.slice(at + q.length, at + q.length + SEARCH_CONTEXT),
        progress: total > 0 ? offset / total : 0,
        offset,
      });
      from = at + q.length;
    }
    if (out.length >= SEARCH_MAX_RESULTS) break;
  }
  return out;
}

// The current entry in a position-sorted list: the last one at or before the
// reader's position (-1 when the position precedes every entry). Used for the
// "you are here" marker in both readers' TOC panels.
export function currentIndexBefore(positions: number[], pos: number): number {
  let current = -1;
  for (const [index, entryPos] of positions.entries()) {
    if (entryPos <= pos) current = index;
  }
  return current;
}
