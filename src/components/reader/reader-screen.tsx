import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Book } from "@/core/library";
import { DICTIONARIES_ENABLED } from "@/core/dictionaries";
import {
  fontFamilyStack,
  readingTheme,
  type ReadingSettings,
} from "@/core/reading-settings";
import type { OpenedData } from "@/components/library/use-shelf";
import { OcrQueuePanel } from "@/components/ocr-queue-panel";
import { DashRing } from "@/components/ui/dash-ring";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";
import { useEscapeKey } from "@/lib/use-escape-key";
import { ReadingView } from "./reading-view";
import { MangaReadingView } from "./manga-reading-view";
import { ReaderChrome } from "./reader-chrome";
import type { ReaderPanelMode } from "./reader-panel";
import { DictionaryLookupLayer } from "./dictionary-popup";

// The PDF view pulls in pdf.js (~350 kB min) — code-split, so only opening
// an actual PDF pays for it. Declared at module level: a lazy component
// created inside render would reset its state on every re-render.
const PdfReadingView = lazy(() =>
  import("./pdf-reading-view").then((module) => ({
    default: module.PdfReadingView,
  })),
);

// While the PDF chunk streams in, paint the same surface the view itself
// paints (reading-bg, centered) so the swap reads as loading, not a hole.
function PdfViewFallback() {
  return (
    <div
      className="grid h-full w-full place-items-center"
      style={{ background: "var(--reading-bg, var(--ds-surface-canvas))" }}
    >
      <DashRing
        className="size-6"
        style={{ color: "var(--reading-muted, var(--ds-content-muted))" }}
      />
    </div>
  );
}

// The full-screen reader: the book view (EPUB reflow or PDF pages) and the
// auto-hiding chrome. Reader-only UI state
// (side panels, the PDF outline flag) lives here — the app shell
// just routes to this screen and feeds it the session's onProgress.
//   Touch: the views own the gestures (bands, swipes, pinch) and report a
// middle-band tap; the controls — the top pill and the bottom scrubber —
// show and hide together from here. A phone opens a book with them up, so
// the way out is never hidden; the first page turn puts them away.
//   The book surface stays clear of the system insets (status bar and
// Dynamic Island, home indicator, landscape sensor housing) and paints
// them in the page color, as does the browser's own status-bar tint.
export function ReaderScreen({
  book,
  books,
  data,
  settings,
  onSettingsChange,
  onProgress,
  onExit,
}: {
  book: Book;
  /** The whole shelf — the OCR queue panel lists other volumes too. */
  books: Book[];
  data: OpenedData;
  settings: ReadingSettings;
  onSettingsChange: (settings: ReadingSettings) => void;
  onProgress: (progress: number, absolute: number, pageChars: number) => void;
  onExit: () => void;
}) {
  // Reader side panels (TOC / search) — one at a time, owned here so the
  // chrome buttons and the views stay in sync.
  const [panel, setPanel] = useState<ReaderPanelMode>(null);
  // Settings popover is controlled from here so Escape can close it before
  // anything else reacts.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Only the PDF view knows whether the document has an outline (post-load),
  // so it reports up and the chrome's TOC button follows.
  const [pdfHasOutline, setPdfHasOutline] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  // Touch controls (pill + scrubber bar). Phones open with them up.
  const [controls, setControls] = useState(coarse);

  // One Escape for the whole reader, innermost layer first: settings popover,
  // then side panel, then exit — but PDF never exits on Escape.
  useEscapeKey(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (panel !== null) {
      setPanel(null);
      return;
    }
    if (book.format === "epub" || book.format === "manga") onExit();
  });

  // Book switch (or exit) closes the panels and settings and forgets the old
  // outline flag.
  useEffect(() => {
    setPanel(null);
    setSettingsOpen(false);
    setPdfHasOutline(false);
  }, [book.id]);

  // The browser paints its status-bar area from theme-color: follow the page
  // while reading, give the shelf its canvas back on the way out.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const previous = meta.content;
    meta.content = readingTheme(settings.theme).bg;
    return () => {
      meta.content = previous;
    };
  }, [settings.theme]);

  // The reading surface's own custom properties: both book views and the
  // chrome read these, so a theme/font change repaints everything at once.
  const readingStyle = useMemo(() => {
    const theme = readingTheme(settings.theme);
    return {
      "--reading-font-family": fontFamilyStack(settings.fontFamily),
      "--reading-font-size": `${settings.fontSize}px`,
      "--reading-font-weight": String(settings.fontWeight),
      "--reading-line-height": String(settings.lineHeight),
      "--reading-bg": theme.bg,
      "--reading-text": theme.text,
      "--reading-muted": theme.muted,
      "--reading-pdf-filter": theme.pdfFilter,
    } as CSSProperties;
  }, [settings]);

  const controlsProps = {
    controlsVisible: controls,
    onControlsChange: setControls,
  };

  return (
    <div ref={readerRef} className="relative min-h-dvh bg-canvas">
      <div
        style={{ ...readingStyle, background: "var(--reading-bg)" }}
        data-furigana={settings.furigana ? undefined : "off"}
        className="h-dvh w-full pt-safe-0 pr-safe-0 pb-safe-0 pl-safe-0"
      >
        {book.format === "pdf" && data.pdfBytes ? (
          <Suspense fallback={<PdfViewFallback />}>
            <PdfReadingView
              pdfBytes={data.pdfBytes}
              initialProgress={book.progress}
              panel={panel}
              onPanelChange={setPanel}
              onOutlineChange={setPdfHasOutline}
              onProgress={onProgress}
              {...controlsProps}
            />
          </Suspense>
        ) : book.format === "manga" ? (
          <MangaReadingView
            bookId={book.id}
            initialProgress={book.progress}
            mangaFirstPageAsCover={settings.mangaFirstPageAsCover}
            onProgress={onProgress}
            {...controlsProps}
          />
        ) : (
          <ReadingView
            chapters={data.chapters}
            language={book.language}
            fontSize={settings.fontSize}
            pageMargin={settings.pageMargin}
            resources={data.resources}
            bookCss={data.bookCss}
            initialProgress={book.progress}
            toc={data.toc}
            panel={panel}
            onPanelChange={setPanel}
            onProgress={onProgress}
            {...controlsProps}
          />
        )}
      </div>
      <ReaderChrome
        onExit={onExit}
        settings={settings}
        onSettingsChange={onSettingsChange}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
        showFontSettings={book.format !== "pdf" && book.format !== "manga"}
        showMangaSettings={book.format === "manga"}
        showSearch={book.format !== "manga"}
        mangaFirstPageAsCover={settings.mangaFirstPageAsCover}
        onMangaFirstPageAsCoverChange={(checked) =>
          onSettingsChange({ ...settings, mangaFirstPageAsCover: checked })
        }
        tocAvailable={
          book.format === "pdf" ? pdfHasOutline : (data.toc?.length ?? 0) > 0
        }
        panel={panel}
        onPanelChange={setPanel}
        touchVisible={controls}
      />
      <OcrQueuePanel
        books={books}
        defaultCollapsed
        placement="reader"
        suppressed={controls}
      />
      <DictionaryLookupLayer
        rootRef={readerRef}
        enabled={DICTIONARIES_ENABLED && book.format !== "pdf"}
      />
    </div>
  );
}
