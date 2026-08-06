import { useMemo } from "react";
import type { TocEntry } from "@/core/reading";
import type { ArticleBuild } from "./book-html";
import {
  buildSearchResults,
  buildTocEntries,
  currentIndexBefore,
} from "./panels-data";
import {
  SearchPanel,
  TocPanel,
  type ReaderPanelMode,
} from "./reader-panel";

// The reader's side panels (TOC, search): their entries derive from the
// built book model, the jumps are the view's (it owns section navigation).
export function ReadingPanels({
  panel,
  toc,
  model,
  exploredCount,
  searchQuery,
  onSearchQueryChange,
  onJumpSection,
  onJumpChar,
  onClose,
}: {
  panel: ReaderPanelMode;
  toc?: TocEntry[];
  /** The built book: sections, search index, totals (null before build). */
  model: ArticleBuild | null;
  /** Global char position — the TOC's "current entry" follows it. */
  exploredCount: number;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onJumpSection: (index: number) => void;
  onJumpChar: (offset: number) => void;
  onClose: () => void;
}) {
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

  return (
    <>
      {panel === "toc" ? (
        <TocPanel
          entries={tocEntries.map((entry, index) => ({
            label: entry.label,
            progress: entry.progress,
            current: index === currentTocIndex,
          }))}
          onJump={(index) => onJumpSection(tocEntries[index]!.section)}
          onClose={onClose}
        />
      ) : null}
      {panel === "search" ? (
        <SearchPanel
          query={searchQuery}
          onQueryChange={onSearchQueryChange}
          results={searchResults}
          searching={false}
          onJump={(index) => onJumpChar(searchResults[index]!.offset)}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}
