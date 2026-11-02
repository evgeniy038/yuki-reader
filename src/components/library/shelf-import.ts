import type { Dispatch, SetStateAction } from "react";
import i18n from "@/lib/i18n";
import { bookContentHash } from "@/core/book-hash";
import { importBookFile } from "@/core/import-book";
import {
  importMangaItems,
  isMangaItem,
  type ImportedMangaVolume,
  type MangaInputItem,
} from "@/core/import-manga";
import { seriesShelfId, type Book } from "@/core/library";
import { normalizeSeriesKey } from "@/core/mokuro";
import { trackMangaOcr } from "@/core/ocr/ocr";
import { putBook, putMangaVolume, type BookRecord } from "@/core/storage";
import type { OpenedData } from "./use-shelf";

interface ShelfImportDeps {
  books: Book[];
  setBooks: Dispatch<SetStateAction<Book[]>>;
  dataRef: { current: Map<string, OpenedData> };
  setError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setFlashId: Dispatch<SetStateAction<string | null>>;
}

// Book/manga import for the shelf (see use-shelf): files become book records
// + payload-map entries + storage writes. Rebuilt every render off the
// current books — the methods read `books` directly (never inside setBooks
// updaters), which is fresh enough for an event-handler context.
export function createShelfImport({
  books,
  setBooks,
  dataRef,
  setError,
  setNotice,
  setFlashId,
}: ShelfImportDeps) {
  const importFile = async (file: File) => {
    try {
      const imported = await importBookFile(file);
      if (imported.kind === "manga") {
        void navigator.storage?.persist?.();
        shelveMangaVolumes([imported.volume]);
        setError(null);
        return;
      }

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
      shelveMangaVolumes(await importMangaItems(items), targetSeries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t("library.openError"));
    }
  };

  // Shelve imported volumes, skipping ones already on the shelf (or twice in
  // this batch) — an existing duplicate is flashed instead.
  const shelveMangaVolumes = (
    volumes: ImportedMangaVolume[],
    targetSeries?: string,
  ) => {
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

  return { importFiles, importManga };
}
