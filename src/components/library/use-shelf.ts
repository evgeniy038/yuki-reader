import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import i18n from "@/lib/i18n";
import { bookContentHash } from "@/core/book-hash";
import { importBookFile } from "@/core/import-book";
import {
  importMangaItems,
  isMangaItem,
  type ImportedMangaVolume,
  type MangaInputItem,
} from "@/core/import-manga";
import { detectLanguage, seriesShelfId, type Book } from "@/core/library";
import { normalizeSeriesKey } from "@/core/mokuro";
import { cancelOcr, trackMangaOcr } from "@/core/ocr/ocr";
import { deriveToc } from "@/core/reading";
import type { Chapter, EpubResource, TocEntry } from "@/core/reading";
import {
  deleteBook,
  loadAllBooks,
  putBook,
  putMangaVolume,
  updateBookMeta,
  type BookRecord,
} from "@/core/storage";

/** Everything needed to open a book in the reader, kept out of React state. */
export interface OpenedData {
  metadata: { title: string; creator?: string; language?: string };
  chapters: Chapter[];
  /** Table of contents (EPUB): parsed NCX/nav, or derived from chapters. */
  toc?: TocEntry[];
  resources: EpubResource[];
  bookCss: string;
  /** Raw PDF bytes — the PDF reader renders pages straight from them. */
  pdfBytes?: Uint8Array;
  /** Total pages (PDF only). */
  pageCount?: number;
}

// The shelf: the book list plus the heavy per-book payloads (chapters, bytes).
// The list lives in state (it drives the UI); the payloads live in a ref map —
// they never change after import and must not re-render anything. All book
// mutations (import, open, rename, cover, delete) go through this hook so the
// list, the payload map and the storage write stay in lockstep.
export function useShelf(demoMode: boolean) {
  const [books, setBooks] = useState<Book[]>([]);
  // The shelf loads from storage asynchronously — until it resolves we show
  // the loader, not the empty state.
  const [shelfReady, setShelfReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const dataRef = useRef<Map<string, OpenedData>>(new Map());
  const navigate = useNavigate();

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    loadAllBooks()
      .then(async (records) => {
        if (!active) return;
        const loaded: Book[] = [];
        for (const record of records) {
          // Backfill fields introduced after the book was stored.
          if (!record.contentHash) {
            record.contentHash = await bookContentHash(
              record.title,
              record.author,
              record.chapters,
            );
            void updateBookMeta(record.id, { contentHash: record.contentHash });
          }
          if (!record.format) {
            record.format =
              (record.resources?.length ?? 0) > 0 || record.bookCss
                ? "epub"
                : "pdf";
            void updateBookMeta(record.id, { format: record.format });
          }
          if (!record.language) {
            record.language = detectLanguage(
              record.chapters
                .slice(0, 3)
                .map((chapter) => chapter.html)
                .join(""),
            );
          }
          dataRef.current.set(record.id, {
            metadata: {
              title: record.title,
              creator: record.author,
              language: record.language,
            },
            chapters: record.chapters,
            // Records from before TOC parsing derive labels from chapters.
            toc:
              record.toc ??
              (record.format === "pdf" || record.format === "manga"
                ? undefined
                : deriveToc(record.chapters)),
            resources: record.resources ?? [],
            bookCss: record.bookCss ?? "",
            pdfBytes: record.pdfBytes,
            pageCount: record.pageCount,
          });
          loaded.push({
            id: record.id,
            title: record.title,
            author: record.author,
            language: record.language,
            format: record.format,
            progress: record.progress,
            cover: record.cover,
            contentHash: record.contentHash,
            pageCount: record.pageCount,
            series: record.series,
            volumeIndex: record.volumeIndex,
            addedAt: record.addedAt,
            lastReadAt: record.lastReadAt,
          });
        }
        setBooks(loaded);
        setShelfReady(true);
      })
      .catch(() => {
        // storage unavailable — shelf stays empty
        setShelfReady(true);
      });
    return () => {
      active = false;
    };
  }, [demoMode]);

  // A duplicate-import notice auto-clears.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Flash a shelf card (duplicate import): scroll to it, pulse, auto-clear.
  useEffect(() => {
    if (!flashId) return;
    document
      .querySelector(`[data-book-id="${flashId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => setFlashId(null), 2500);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  const importFile = async (file: File) => {
    try {
      const imported = await importBookFile(file);

      // Duplicate rejection: same content fingerprint as a shelved book →
      // don't add; flash the existing card instead.
      const contentHash = await bookContentHash(
        imported.title,
        imported.author,
        imported.chapters,
      );
      const duplicate = books.find((book) => book.contentHash === contentHash);
      if (duplicate) {
        setNotice(i18n.t("library.duplicate", { title: duplicate.title }));
        setFlashId(duplicate.id);
        return;
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const record: BookRecord = {
        id,
        title: imported.title,
        author: imported.author,
        language: imported.language,
        format: imported.format,
        progress: 0,
        chapters: imported.chapters,
        toc: imported.toc,
        cover: imported.cover,
        resources: imported.resources,
        bookCss: imported.bookCss,
        pdfBytes: imported.pdfBytes,
        pageCount: imported.pageCount,
        contentHash,
        addedAt: now,
        lastReadAt: now,
      };
      dataRef.current.set(id, {
        metadata: {
          title: imported.title,
          creator: imported.author,
          language: imported.language,
        },
        chapters: imported.chapters,
        toc: imported.toc,
        resources: imported.resources,
        bookCss: imported.bookCss,
        pdfBytes: imported.pdfBytes,
        pageCount: imported.pageCount,
      });
      const book: Book = {
        id,
        title: imported.title,
        author: imported.author,
        language: imported.language,
        format: imported.format,
        progress: 0,
        cover: imported.cover,
        contentHash,
        pageCount: imported.pageCount,
        addedAt: now,
        lastReadAt: now,
      };
      // No auto-open: batch imports land on the shelf, the tile opens the book.
      setBooks((prev) => [book, ...prev]);
      setError(null);
      void putBook(record);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : i18n.t("library.openError"),
      );
    }
  };

  // Manga import: archives and image/sidecar drops become volumes. Each
  // volume is a shelved book (format "manga") whose heavy payload — page
  // scans — goes to the manga stores, not the book record. Series merge by
  // normalized name; a volume number that is already taken (or missing)
  // lands at the end of the series.
  const importManga = async (
    items: MangaInputItem[],
    targetSeries?: string,
  ) => {
    try {
      // Page scans are large — ask the browser not to evict our storage.
      void navigator.storage?.persist?.();
      const volumes = await importMangaItems(items);
      const batchHashes = new Set<string>();
      for (const volume of volumes) {
        const duplicate =
          batchHashes.has(volume.contentHash) ||
          books.find((book) => book.contentHash === volume.contentHash);
        if (duplicate) {
          const existing =
            typeof duplicate === "object" ? duplicate : undefined;
          if (existing) {
            setNotice(i18n.t("library.duplicate", { title: existing.title }));
            setFlashId(
              existing.series
                ? seriesShelfId(existing.series)
                : existing.id,
            );
          }
          continue;
        }
        batchHashes.add(volume.contentHash);
        addMangaVolume(volume, targetSeries);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t("library.openError"));
    }
  };

  // Sync shelf state + storage writes for one imported volume. Kept out of
  // setBooks updaters (they must stay pure) — the state read is fresh enough
  // for an event-handler context.
  const addMangaVolume = (
    volume: ImportedMangaVolume,
    targetSeries?: string,
  ) => {
    const series = targetSeries ?? volume.series;
    const siblings = books.filter(
      (book) =>
        book.format === "manga" &&
        book.series !== undefined &&
        normalizeSeriesKey(book.series) === normalizeSeriesKey(series),
    );
    const used = new Set(siblings.map((book) => book.volumeIndex));
    let volumeIndex = volume.volumeIndex;
    if (volumeIndex === undefined || used.has(volumeIndex)) {
      volumeIndex = Math.max(0, ...siblings.map((b) => b.volumeIndex ?? 0)) + 1;
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = volume.volumeName.replace(/_/g, " ");
    const record: BookRecord = {
      id,
      title,
      language: "ja",
      format: "manga",
      progress: 0,
      chapters: [],
      cover: volume.cover,
      pageCount: volume.pages.length,
      contentHash: volume.contentHash,
      series,
      volumeIndex,
      addedAt: now,
      lastReadAt: now,
    };
    dataRef.current.set(id, {
      metadata: { title, language: "ja" },
      chapters: [],
      resources: [],
      bookCss: "",
      pageCount: volume.pages.length,
    });
    const book: Book = {
      id,
      title,
      language: "ja",
      format: "manga",
      progress: 0,
      cover: volume.cover,
      contentHash: volume.contentHash,
      pageCount: volume.pages.length,
      series,
      volumeIndex,
      addedAt: now,
      lastReadAt: now,
    };
    setBooks((prev) => [book, ...prev]);
    void putBook(record);
    void putMangaVolume({ id, pages: volume.pages }, volume.blobs).then(() => {
      // Pages without a sidecar go through in-app OCR (the worker needs the
      // page blobs in place first — hence after the put resolves): detect
      // boxes for the whole volume, then the background recognition march.
      // The volume stays gated on the shelf until the detect stage is done.
      void trackMangaOcr(id);
    });
  };

  /** Mixed drop/selection entry point: book files one way, manga the other. */
  const importFiles = (items: MangaInputItem[]) => {
    const bookFiles = items.filter(
      (item) => !isMangaItem(item) || /\.(epub|pdf)$/i.test(item.file.name),
    );
    const mangaItems = items.filter(
      (item) => isMangaItem(item) && !/\.(epub|pdf)$/i.test(item.file.name),
    );
    for (const item of bookFiles) void importFile(item.file);
    if (mangaItems.length > 0) void importManga(mangaItems);
  };

  // Rename every volume's series label.
  const renameSeries = (oldSeries: string, next: string) => {
    const ids = books
      .filter((book) => book.series === oldSeries)
      .map((book) => book.id);
    setBooks((prev) =>
      prev.map((book) =>
        book.series === oldSeries ? { ...book, series: next } : book,
      ),
    );
    for (const id of ids) void updateBookMeta(id, { series: next });
  };

  // Move one volume to another series (existing or new): it lands at the
  // end unless its own number is still free there.
  const moveVolumeToSeries = (id: string, series: string) => {
    const volume = books.find((book) => book.id === id);
    if (!volume || volume.series === series) return;
    const taken = new Set(
      books
        .filter((book) => book.series === series)
        .map((book) => book.volumeIndex),
    );
    const volumeIndex =
      volume.volumeIndex !== undefined && !taken.has(volume.volumeIndex)
        ? volume.volumeIndex
        : Math.max(0, ...[...taken].filter((n): n is number => n !== undefined)) + 1;
    setBooks((prev) =>
      prev.map((book) =>
        book.id === id ? { ...book, series, volumeIndex } : book,
      ),
    );
    void updateBookMeta(id, { series, volumeIndex });
  };

  // Move a whole series into another one (merge): volumes keep their numbers
  // where free, the rest land at the end in order.
  const moveSeries = (fromSeries: string, toSeries: string) => {
    if (fromSeries === toSeries) return;
    const taken = new Set(
      books
        .filter((book) => book.series === toSeries)
        .map((book) => book.volumeIndex),
    );
    let next =
      Math.max(0, ...[...taken].filter((n): n is number => n !== undefined)) + 1;
    const moving = books
      .filter((book) => book.series === fromSeries)
      .sort(
        (a, b) =>
          (a.volumeIndex ?? Infinity) - (b.volumeIndex ?? Infinity) ||
          a.addedAt - b.addedAt,
      );
    const assignments = new Map<string, { series: string; volumeIndex: number }>();
    for (const volume of moving) {
      let index = volume.volumeIndex;
      if (index === undefined || taken.has(index)) index = next++;
      taken.add(index);
      assignments.set(volume.id, { series: toSeries, volumeIndex: index });
    }
    setBooks((prev) =>
      prev.map((book) => {
        const patch = assignments.get(book.id);
        return patch ? { ...book, ...patch } : book;
      }),
    );
    assignments.forEach((patch, id) => void updateBookMeta(id, patch));
  };

  // Persist a manual reorder: positions become 1..n in the given id order.
  const setVolumeOrder = (orderedIds: string[]) => {
    setBooks((prev) =>
      prev.map((book) => {
        const index = orderedIds.indexOf(book.id);
        return index === -1 ? book : { ...book, volumeIndex: index + 1 };
      }),
    );
    orderedIds.forEach((id, index) => {
      void updateBookMeta(id, { volumeIndex: index + 1 });
    });
  };

  // Delete a whole series: every volume, pages included (deleteBook cascades).
  const removeSeries = (series: string) => {
    const ids = books
      .filter((book) => book.series === series)
      .map((book) => book.id);
    setBooks((prev) => prev.filter((book) => book.series !== series));
    for (const id of ids) {
      dataRef.current.delete(id);
      cancelOcr(id);
      void deleteBook(id);
    }
  };

  // Opening a book bumps it to the top of the recency sort.
  const openBook = (id: string) => {
    if (!dataRef.current.has(id)) return;
    const now = Date.now();
    setBooks((prev) =>
      prev.map((book) => (book.id === id ? { ...book, lastReadAt: now } : book)),
    );
    void updateBookMeta(id, { lastReadAt: now });
    navigate(`/read/${id}`);
  };

  const removeBook = (id: string) => {
    setBooks((prev) => prev.filter((book) => book.id !== id));
    dataRef.current.delete(id);
    cancelOcr(id);
    void deleteBook(id);
  };

  const renameBook = (id: string, title: string) => {
    setBooks((prev) =>
      prev.map((book) => (book.id === id ? { ...book, title } : book)),
    );
    const data = dataRef.current.get(id);
    if (data) data.metadata = { ...data.metadata, title };
    void updateBookMeta(id, { title });
  };

  const changeCover = (id: string, cover: string) => {
    setBooks((prev) =>
      prev.map((book) => (book.id === id ? { ...book, cover } : book)),
    );
    void updateBookMeta(id, { cover });
  };

  return {
    books,
    setBooks,
    shelfReady,
    setShelfReady,
    error,
    notice,
    flashId,
    dataRef,
    importFile,
    importFiles,
    importManga,
    openBook,
    removeBook,
    removeSeries,
    renameBook,
    renameSeries,
    moveVolumeToSeries,
    moveSeries,
    setVolumeOrder,
    changeCover,
  };
}
