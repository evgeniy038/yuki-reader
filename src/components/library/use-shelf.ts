import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { bookContentHash } from "@/core/book-hash";
import { detectLanguage, type Book } from "@/core/library";
import { cancelOcr } from "@/core/ocr/ocr";
import { deriveToc } from "@/core/reading";
import type { Chapter, EpubResource, TocEntry } from "@/core/reading";
import {
  deleteBook,
  loadAllBooks,
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
          });
          loaded.push({ ...record });
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
  };
}
