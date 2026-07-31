import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import i18n from "@/lib/i18n";
import { bookContentHash } from "@/core/book-hash";
import { importBookFile } from "@/core/import-book";
import { detectLanguage, type Book } from "@/core/library";
import { deriveToc } from "@/core/reading";
import type { Chapter, EpubResource, TocEntry } from "@/core/reading";
import {
  deleteBook,
  loadAllBooks,
  putBook,
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
              (record.format === "pdf"
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
    openBook,
    removeBook,
    renameBook,
    changeCover,
  };
}
