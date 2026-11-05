import { lazy, Suspense, useEffect, useState } from "react";
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
import { NavPill, type AppView } from "@/components/library/nav-pill";
import { OcrQueuePanel } from "@/components/ocr-queue-panel";
import { useShelf, type OpenedData } from "@/components/library/use-shelf";
import { useFileDrop } from "@/components/library/use-drag-drop";
import { useGoalBook } from "@/components/library/use-goal-book";
import { ReaderScreen } from "@/components/reader/reader-screen";
import { useReadingSession } from "@/components/reader/use-reading-session";
import { useSync } from "@/components/sync/use-sync";
import { DashRing } from "@/components/ui/dash-ring";
import { demoModeRequested, useDemoBook } from "@/components/use-demo-mode";

// Second-layer pages code-split off the shell: the library and the reader
// (the app's main verbs) stay in the entry chunk; stats, settings and the
// manga series page stream in on first visit. Declared at module level —
// a lazy component created inside render resets state every re-render.
const StatsView = lazy(() =>
  import("@/components/library/stats-view").then((module) => ({
    default: module.StatsView,
  })),
);
const SettingsPage = lazy(() =>
  import("@/components/library/settings-page").then((module) => ({
    default: module.SettingsPage,
  })),
);
const MangaPage = lazy(() =>
  import("@/components/library/manga-page").then((module) => ({
    default: module.MangaPage,
  })),
);

/** The reader payload of a manga volume: metadata only. */
function mangaData(book: Book): OpenedData {
  return {
    metadata: { title: book.title, language: book.language },
    chapters: [],
    resources: [],
    bookCss: "",
  };
}

// Shown in the routed area while a second-layer page's chunk loads.
function RouteFallback() {
  return (
    <div className="grid h-full place-items-center">
      <DashRing className="size-6 text-muted-content" />
    </div>
  );
}

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
          pageTurnAnimation: true,
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
  // The open book's payload loads on demand (the shelf holds metadata only);
  // fresh imports and recent opens come straight from the in-memory cache.
  // null = the book has no stored content — the shell's redirect takes it.
  const [loaded, setLoaded] = useState<{
    id: string;
    data: OpenedData | null;
  } | null>(null);
  // A manga volume needs no payload — its reader reads the page stores.
  const cachedData = openedId
    ? (shelf.dataRef.current.get(openedId) ??
      (openedBook?.format === "manga" ? mangaData(openedBook) : undefined))
    : undefined;
  const openedData =
    cachedData ?? (loaded && loaded.id === openedId ? loaded.data : undefined);
  const { shelfReady, loadBookData } = shelf;
  const needsData = !!openedBook && openedData === undefined;
  useEffect(() => {
    if (!openedId || !shelfReady || !needsData) return;
    let alive = true;
    void loadBookData(openedId).then(
      (data) => alive && setLoaded({ id: openedId, data: data ?? null }),
      () => alive && setLoaded({ id: openedId, data: null }),
    );
    return () => {
      alive = false;
    };
    // loadBookData is rebuilt every render; the id and readiness drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedId, shelfReady, needsData]);

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

  // Device sync (lazy: loads only on devices that sync) — see use-sync.ts.
  const { readerKey, cloud } = useSync({
    books: shelf.books,
    shelfReady: shelf.shelfReady,
    setBooks: shelf.setBooks,
    dataRef: shelf.dataRef,
    removeBook: shelf.removeBook,
    readingSettings,
    setReadingSettings,
    openedBook,
  });

  const { dragging, handlers: dropHandlers } = useFileDrop(shelf.importFiles);

  // After a reload the OCR queue is gone but the results are not — rebuild
  // the march for every unfinished volume from storage.
  useEffect(() => {
    resumeMangaOcr();
  }, []);

  const { goalBook, setGoalBookId } = useGoalBook(
    shelf.books,
    loadBookData,
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
          key={readerKey}
          book={openedBook}
          books={shelf.books}
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
      </>
    );
  }

  // The URL asks for a book but the shelf (or the book's payload) is still
  // loading: hold a quiet loader instead of bouncing to the library — the
  // id may well be valid (this is the refresh-while-reading path). A
  // genuinely unknown id falls through to the shell, whose catch-all
  // redirects home.
  if (openedId && (!shelf.shelfReady || needsData)) {
    return (
      <div className="grid h-dvh place-items-center bg-canvas">
        <DashRing className="size-6 text-muted-content" />
      </div>
    );
  }

  return (
    <div className="h-dvh bg-canvas" {...dropHandlers}>
      <main className="h-full overflow-y-auto">
        <Routes>
          <Route
            path="stats"
            element={
              <Suspense fallback={<RouteFallback />}>
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
              </Suspense>
            }
          />
          <Route
            path="settings"
            element={
              <Suspense fallback={<RouteFallback />}>
                <SettingsPage
                  settings={readingSettings}
                  onSettingsChange={setReadingSettings}
                />
              </Suspense>
            }
          />
          <Route
            path="manga/:seriesKey"
            element={
              <Suspense fallback={<RouteFallback />}>
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
                  onKeepInCloud={shelf.setKeepInCloud}
                  inCloud={cloud.inCloud}
                  onRemoveDownload={cloud.removeDownload}
                />
              </Suspense>
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
                loadBookData={loadBookData}
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
                cloud={cloud}
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
