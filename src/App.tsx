import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router";
import type { Book } from "@/core/library";
import { normalizeSeriesKey } from "@/core/mokuro";
import {
  FONT_FAMILY_DEFAULT,
  FONT_SIZE_DEFAULT,
  FONT_WEIGHT_DEFAULT,
  LINE_HEIGHT_DEFAULT,
  PAGE_MARGIN_DEFAULT,
  loadReadingSettings,
  saveReadingSettings,
  type ReadingSettings,
} from "@/core/reading-settings";
import { saveProgress } from "@/core/storage";
import { resumeMangaOcr } from "@/core/ocr/ocr";
import { LibraryPage } from "@/components/library/library-page";
import { MangaPage } from "@/components/library/manga-page";
import { NavPill, type AppView } from "@/components/library/nav-pill";
import { OcrQueuePanel } from "@/components/ocr-queue-panel";
import { SettingsPage } from "@/components/library/settings-page";
import { StatsView } from "@/components/library/stats-view";
import { useShelf } from "@/components/library/use-shelf";
import { useFileDrop } from "@/components/library/use-drag-drop";
import { useGoalBook } from "@/components/library/use-goal-book";
import { ReaderScreen } from "@/components/reader/reader-screen";
import { useReadingSession } from "@/components/reader/use-reading-session";
import { DashRing } from "@/components/ui/dash-ring";
import { demoModeRequested, useDemoBook } from "@/components/use-demo-mode";

// The app shell: routing, the stores (shelf, reading settings) and
// their wiring to screens. All book/session logic lives in the hooks and
// screens — this file only composes them.
export default function App() {
  const { t } = useTranslation();
  const demoMode = demoModeRequested();

  const shelf = useShelf(demoMode);

  const [readingSettings, setReadingSettings] = useState<ReadingSettings>(() =>
    typeof window !== "undefined"
      ? loadReadingSettings()
      : {
          fontFamily: FONT_FAMILY_DEFAULT,
          fontSize: FONT_SIZE_DEFAULT,
          fontWeight: FONT_WEIGHT_DEFAULT,
          lineHeight: LINE_HEIGHT_DEFAULT,
          furigana: true,
          pageMargin: PAGE_MARGIN_DEFAULT,
          theme: "light",
          mangaFirstPageAsCover: true,
        },
  );
  useEffect(() => {
    saveReadingSettings(readingSettings);
  }, [readingSettings]);

  // Every screen is a real URL — a refresh reloads exactly where you were.
  // The current view and the open book are derived from the location, never
  // stored as state.
  const navigate = useNavigate();
  const location = useLocation();
  const view: AppView = location.pathname.startsWith("/stats")
    ? "stats"
    : location.pathname.startsWith("/settings")
      ? "settings"
      : "library";
  const readMatch = useMatch("/read/:bookId");
  const openedId = readMatch?.params.bookId ?? null;
  const openedBook = openedId
    ? shelf.books.find((book) => book.id === openedId)
    : undefined;
  const openedData = openedId ? shelf.dataRef.current.get(openedId) : undefined;

  // Bookmark dwell, active-time heartbeat, warmup gate — see the hook.
  const { updateProgress, resetSession } = useReadingSession({
    bookId: openedId,
    format: openedBook?.format,
    onBookmark: (id, progress) => {
      const now = Date.now();
      shelf.setBooks((prev) =>
        prev.map((book) =>
          book.id === id ? { ...book, progress, lastReadAt: now } : book,
        ),
      );
      void saveProgress(id, progress);
    },
  });

  const { dragging, handlers: dropHandlers } = useFileDrop(shelf.importFiles);

  // After a reload the OCR queue is gone but the results are not — rebuild
  // the march for every unfinished volume from storage.
  useEffect(() => {
    resumeMangaOcr();
  }, []);

  const getBookData = useCallback(
    (id: string) => shelf.dataRef.current.get(id),
    [shelf.dataRef],
  );
  const { goalBook, setGoalBookId } = useGoalBook(
    shelf.books,
    getBookData,
    view === "stats",
  );

  const openBook = (id: string) => {
    // Fresh reading session: a reopen never inherits the previous visit's
    // accumulation (counted pages, warmup clock).
    resetSession();
    shelf.openBook(id);
  };

  useDemoBook(shelf, demoMode);

  if (openedBook && openedData) {
    return (
      <>
        <ReaderScreen
          book={openedBook}
          data={openedData}
          settings={readingSettings}
          onSettingsChange={setReadingSettings}
          onProgress={updateProgress}
          onExit={() =>
            // A manga volume exits to its series, not all the way to the shelf.
            openedBook.format === "manga" && openedBook.series
              ? navigate(
                  `/manga/${encodeURIComponent(normalizeSeriesKey(openedBook.series))}`,
                )
              : navigate("/")
          }
        />
        <OcrQueuePanel books={shelf.books} defaultCollapsed />
      </>
    );
  }

  // The URL asks for a book but the shelf is still loading: hold a quiet
  // loader instead of bouncing to the library — the id may well be valid
  // (this is the refresh-while-reading path). A genuinely unknown id falls
  // through to the shell, whose catch-all redirects home.
  if (openedId && !shelf.shelfReady) {
    return (
      <div className="grid h-screen place-items-center bg-canvas">
        <DashRing className="size-6 text-muted-content" />
      </div>
    );
  }

  return (
    <div className="h-screen bg-canvas" {...dropHandlers}>
      <main className="h-full overflow-y-auto">
        <Routes>
          <Route
            path="stats"
            element={
              <StatsView
                books={shelf.books}
                goalBook={goalBook}
                goalBookOptions={shelf.books.map((book) => ({
                  id: book.id,
                  title: book.title,
                  cover: book.cover,
                }))}
                onGoalBookChange={setGoalBookId}
              />
            }
          />
          <Route
            path="settings"
            element={
              <SettingsPage
                settings={readingSettings}
                onSettingsChange={setReadingSettings}
              />
            }
          />
          <Route
            path="manga/:seriesKey"
            element={
              <MangaPage
                books={shelf.books}
                shelfReady={shelf.shelfReady}
                error={shelf.error}
                notice={shelf.notice}
                onOpenBook={openBook}
                onRenameBook={shelf.renameBook}
                onDeleteBook={shelf.removeBook}
                onRenameSeries={shelf.renameSeries}
                onMoveVolume={shelf.moveVolumeToSeries}
                onMoveSeries={shelf.moveSeries}
                onDeleteSeries={shelf.removeSeries}
                onReorder={shelf.setVolumeOrder}
                onAddVolumes={shelf.importManga}
              />
            }
          />
          <Route
            index
            element={
              <LibraryPage
                books={shelf.books}
                shelfReady={shelf.shelfReady}
                error={shelf.error}
                notice={shelf.notice}
                flashId={shelf.flashId}
                dataRef={shelf.dataRef}
                onOpenBook={openBook}
                onImportFiles={shelf.importFiles}
                onRenameBook={shelf.renameBook}
                onDeleteBook={shelf.removeBook}
                onChangeCover={shelf.changeCover}
                onToggleFavorite={shelf.toggleFavorite}
                onOpenSeries={(series) =>
                  navigate(`/manga/${encodeURIComponent(normalizeSeriesKey(series))}`)
                }
                onRenameSeries={shelf.renameSeries}
                onDeleteSeries={shelf.removeSeries}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <NavPill
        view={view}
        onViewChange={(next) => navigate(next === "library" ? "/" : `/${next}`)}
      />
      <OcrQueuePanel books={shelf.books} />
      {dragging ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-scrim animate-in fade-in-0 duration-100">
          <p className="rounded-card bg-raised px-6 py-3 text-sm text-strong animate-in fade-in-0 zoom-in-95 duration-100">
            {t("drop")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
