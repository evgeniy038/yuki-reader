import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Book } from "@/core/library";
import {
  fontFamilyStack,
  readingTheme,
  type ReadingSettings,
} from "@/core/reading-settings";
import type { OpenedData } from "@/components/library/use-shelf";
import { useEscapeKey } from "@/lib/use-escape-key";
import { ReadingView } from "./reading-view";
import { PdfReadingView } from "./pdf-reading-view";
import { MangaReadingView } from "./manga-reading-view";
import { ReaderChrome } from "./reader-chrome";
import type { ReaderPanelMode } from "./reader-panel";
import { DictionaryLookupLayer } from "./dictionary-popup";

// The full-screen reader: the book view (EPUB reflow or PDF pages) and the
// auto-hiding chrome. Reader-only UI state
// (side panels, the PDF outline flag) lives here — the app shell
// just routes to this screen and feeds it the session's onProgress.
export function ReaderScreen({
  book,
  data,
  settings,
  onSettingsChange,
  onProgress,
  onExit,
}: {
  book: Book;
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

  // Book switch (or exit) closes the panels and settings, and forgets the old
  // outline flag.
  useEffect(() => {
    setPanel(null);
    setSettingsOpen(false);
    setPdfHasOutline(false);
  }, [book.id]);

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

  return (
    <div ref={readerRef} className="relative min-h-screen bg-canvas">
      <div
        style={readingStyle}
        data-furigana={settings.furigana ? undefined : "off"}
        className="h-screen w-full"
      >
        {book.format === "pdf" && data.pdfBytes ? (
          <PdfReadingView
            pdfBytes={data.pdfBytes}
            initialProgress={book.progress}
            panel={panel}
            onPanelChange={setPanel}
            onOutlineChange={setPdfHasOutline}
            onProgress={onProgress}
          />
        ) : book.format === "manga" ? (
          <MangaReadingView
            bookId={book.id}
            initialProgress={book.progress}
            mangaFirstPageAsCover={settings.mangaFirstPageAsCover}
            onProgress={onProgress}
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
      />
      <DictionaryLookupLayer
        rootRef={readerRef}
        enabled={book.format !== "pdf"}
      />
    </div>
  );
}
