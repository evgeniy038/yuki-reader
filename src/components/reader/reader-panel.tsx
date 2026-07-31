import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEscapeKey } from "@/lib/use-escape-key";

// Reader side panels: table of contents and in-book search. One presentational
// shell shared by both reader views — the views own the data (EPUB char
// offsets / PDF pages) and the jump; the panel just renders and reports taps.
// The drawer sits at the left edge over the text; an invisible backdrop
// swallows outside clicks (they would otherwise flip pages).

interface TocItem {
  label: string;
  /** 1-based page where the entry starts (PDF). */
  page?: number;
  /** Share of the book before the entry, 0..1 (EPUB — reflowed books have no
      global pages without a global layout). */
  progress?: number;
  current?: boolean;
}

/** Which reader side panel is open (owned by App, driven by the chrome). */
export type ReaderPanelMode = "toc" | "search" | null;

export interface SearchResultItem {
  before: string;
  match: string;
  after: string;
  /** 1-based page containing the match (PDF). */
  page?: number;
  /** Share of the book before the match, 0..1 (EPUB). */
  progress?: number;
}

// The right-hand position tag of a panel row: a page number when pages exist
// (PDF), otherwise the progress percent.
function PositionTag({ page, progress }: { page?: number; progress?: number }) {
  if (page === undefined && progress === undefined) return null;
  return (
    <span className="shrink-0 text-xs text-muted-content tabular-nums">
      {page ?? `${Math.round((progress ?? 0) * 100)}%`}
    </span>
  );
}

function PanelShell({
  title,
  onClose,
  panel,
  children,
}: {
  title: string;
  onClose: () => void;
  panel: "toc" | "search";
  children: React.ReactNode;
}) {
  useEscapeKey(onClose);
  const { t } = useTranslation();

  return (
    <>
      <button
        type="button"
        aria-label={t("reader.closePanel")}
        onClick={onClose}
        className="fixed inset-0 z-30 cursor-default"
      />
      <div
        data-reader-panel={panel}
        className="fixed bottom-0 left-0 top-0 z-40 flex w-72 animate-in flex-col border-r border-subtle bg-raised shadow-floating slide-in-from-left duration-150"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-subtle pl-4 pr-2">
          <span className="text-sm font-medium text-strong">{title}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            shape="round"
            onClick={onClose}
            title={t("reader.close")}
            aria-label={t("reader.closePanel")}
          >
            <X />
          </Button>
        </div>
        {children}
      </div>
    </>
  );
}

export function TocPanel({
  entries,
  onJump,
  onClose,
}: {
  entries: TocItem[];
  onJump: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PanelShell title={t("reader.toc")} onClose={onClose} panel="toc">
      <div className="flex-1 overflow-y-auto py-1">
        {entries.map((entry, index) => (
          <button
            key={index}
            type="button"
            data-toc-entry=""
            onClick={() => onJump(index)}
            className={cn(
              "flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-muted",
              entry.current
                ? "font-medium text-strong"
                : "text-default",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            <PositionTag page={entry.page} progress={entry.progress} />
          </button>
        ))}
      </div>
    </PanelShell>
  );
}

export function SearchPanel({
  query,
  onQueryChange,
  results,
  searching,
  onJump,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResultItem[];
  /** Async search in flight (PDF pages load one by one). */
  searching: boolean;
  onJump: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PanelShell title={t("reader.search")} onClose={onClose} panel="search">
      <div className="shrink-0 border-b border-subtle p-3">
        <div className="flex items-center gap-2 rounded-lg border border-subtle bg-canvas px-2.5">
          <MagnifyingGlass className="icon-nav shrink-0 text-muted-content" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("reader.searchPlaceholder")}
            aria-label={t("reader.search")}
            autoFocus
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-strong outline-none placeholder:text-muted-content"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {query.trim() === "" ? (
          <p className="px-4 py-3 text-xs text-muted-content">
            {t("reader.searchHint")}
          </p>
        ) : results.length === 0 && !searching ? (
          <p className="px-4 py-3 text-xs text-muted-content">
            {t("reader.searchEmpty")}
          </p>
        ) : (
          results.map((result, index) => (
            <button
              key={index}
              type="button"
              data-search-result=""
              onClick={() => onJump(index)}
              className="flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-muted"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-default">
                {result.before}
                <mark className="bg-transparent font-medium text-strong">
                  {result.match}
                </mark>
                {result.after}
              </span>
              <PositionTag page={result.page} progress={result.progress} />
            </button>
          ))
        )}
      </div>
    </PanelShell>
  );
}
