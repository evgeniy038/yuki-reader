import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { bookContentHash } from "@/core/book-hash";
import type { Book } from "@/core/library";
import { cancelOcr } from "@/core/ocr/ocr";
import { deriveToc } from "@/core/reading";
import type { Chapter, EpubResource, TocEntry } from "@/core/reading";
import {
  deleteBook,
  loadBookContent,
  loadShelfBooks,
  updateBookMeta,
} from "@/core/storage";
import { createShelfImport } from "./shelf-import";
import { createShelfSeries } from "./shelf-series";

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
}

/** Reader payloads kept in memory: the open book and a couple of recent
    ones (a reopen is instant), never the whole library — on a phone the
    content of every book at once is hundreds of MB. */
const DATA_CACHE_SIZE = 3;

/** Insert as the most recent entry, dropping the oldest beyond the cap. */
export function rememberData(
  cache: Map<string, OpenedData>,
  id: string,
  data: OpenedData,
): void {
  cache.delete(id);
  cache.set(id, data);
  for (const key of cache.keys()) {
    if (cache.size <= DATA_CACHE_SIZE) break;
    cache.delete(key);
  }
}

// The shelf: the book list plus a small cache of per-book payloads
// (chapters, bytes). The list lives in state (it drives the UI); payloads
// load on open and live in a ref map — they never change after import and
// must not re-render anything. All book mutations (import, open, rename,
// cover, delete) go through this hook so the list, the payload cache and
// the storage write stay in lockstep.
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
    // Shelf records only — a few KB per book. Content (chapters, images,
    // PDF bytes) stays on disk until a book is opened (useBookData).
    loadShelfBooks()
      .then((loaded) => {
        if (!active) return;
        setBooks(loaded);
        setShelfReady(true);
        // Backfill the duplicate fingerprint of books stored before it
        // existed — off the startup path, it needs the content.
        for (const book of loaded) {
          if (book.contentHash || book.format === "manga") continue;
          void loadBookContent(book.id).then(async (content) => {
            if (!content) return;
            const contentHash = await bookContentHash(
              book.title,
              book.author,
              content.chapters,
            );
            void updateBookMeta(book.id, { contentHash });
            setBooks((prev) =>
              prev.map((b) => (b.id === book.id ? { ...b, contentHash } : b)),
            );
          });
        }
      })
      .catch(() => {
        // storage unavailable — shelf stays empty
        setShelfReady(true);
      });
    return () => {
      active = false;
    };
  }, [demoMode]);

  // A book's reader payload: from the small in-memory cache (fresh imports,
  // recent opens, the demo book) or from storage. Undefined = not stored.
  const loadBookData = async (id: string): Promise<OpenedData | undefined> => {
    const cached = dataRef.current.get(id);
    if (cached) return cached;
    const book = books.find((b) => b.id === id);
    if (!book) return undefined;
    const content =
      book.format === "manga"
        ? { chapters: [] } // the manga reader reads its own stores
        : await loadBookContent(id);
    if (!content) return undefined;
    const data: OpenedData = {
      metadata: { title: book.title, creator: book.author, language: book.language },
      chapters: content.chapters,
      // Records from before TOC parsing derive labels from chapters.
      toc:
        content.toc ??
        (book.format === "pdf" || book.format === "manga"
          ? undefined
          : deriveToc(content.chapters)),
      resources: content.resources ?? [],
      bookCss: content.bookCss ?? "",
      pdfBytes: content.pdfBytes,
    };
    rememberData(dataRef.current, id, data);
    return data;
  };

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

  const { importFiles, importManga } = createShelfImport({
    books,
    setBooks,
    dataRef,
    setError,
    setNotice,
    setFlashId,
  });
  const {
    renameSeries,
    moveVolumeToSeries,
    moveSeries,
    setVolumeOrder,
    removeSeries,
  } = createShelfSeries({ books, setBooks, dataRef });

  // Opening a book bumps it to the top of the recency sort.
  const openBook = (id: string) => {
    if (!books.some((book) => book.id === id)) return;
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

  // Manga, with sync on: keep these volumes' files in the cloud (or not).
  const setKeepInCloud = (ids: string[], keepInCloud: boolean) => {
    const wanted = new Set(ids);
    setBooks((prev) =>
      prev.map((book) => (wanted.has(book.id) ? { ...book, keepInCloud } : book)),
    );
    for (const id of ids) void updateBookMeta(id, { keepInCloud });
  };

  const toggleFavorite = (id: string) => {
    const target = books.find((book) => book.id === id);
    if (!target) return;
    const favorite = !target.favorite;
    setBooks((prev) =>
      prev.map((book) => (book.id === id ? { ...book, favorite } : book)),
    );
    void updateBookMeta(id, { favorite });
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
    loadBookData,
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
    toggleFavorite,
    setKeepInCloud,
  };
}
