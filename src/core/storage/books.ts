import type { Book } from "../library";
import type { Chapter, EpubResource, TocEntry } from "../reading";
import { BOOK_CONTENT, BOOKS, open } from "./db";
import { deleteManga } from "./manga";

/** The heavy half of a book: what only the reader needs. Stored apart from
    the shelf record (store `bookContent`, keyed by book id), so the shelf
    starts from a few KB per book and a progress save never rewrites
    megabytes of chapters, images or PDF bytes. */
export interface BookContent {
  chapters: Chapter[];
  /** Table of contents (EPUB): NCX/nav entries mapped to spine chapter ids. */
  toc?: TocEntry[];
  resources?: EpubResource[];
  bookCss?: string;
  /** Raw PDF bytes — the PDF reader renders pages straight from them. */
  pdfBytes?: Uint8Array;
}

/** A whole book — shelf metadata plus content (import, backup). */
export interface BookRecord extends Book, BookContent {}

/** What the books store holds: shelf metadata. Records written before the
    v8 split still carry their content inline until the upgrade moves it. */
export type StoredBook = Book & Partial<BookContent>;

/** Split a record into its shelf half and its content half (null when the
    record carries no content — already lean). */
export function splitBook(record: StoredBook): {
  meta: Book;
  content: BookContent | null;
} {
  const { chapters, toc, resources, bookCss, pdfBytes, ...meta } = record;
  if (chapters === undefined) return { meta, content: null };
  return {
    meta,
    content: {
      chapters,
      ...(toc ? { toc } : {}),
      ...(resources ? { resources } : {}),
      ...(bookCss !== undefined ? { bookCss } : {}),
      ...(pdfBytes ? { pdfBytes } : {}),
    },
  };
}

/** Every book's shelf record, newest first — no content is read. */
export async function loadShelfBooks(): Promise<Book[]> {
  const db = await open();
  const records = await db.getAll(BOOKS);
  return records
    .map((record) => splitBook(record).meta)
    .sort((a, b) => b.addedAt - a.addedAt);
}

/** One book's content (chapters, resources, PDF bytes), read on open. */
export async function loadBookContent(id: string): Promise<BookContent | undefined> {
  const db = await open();
  return db.get(BOOK_CONTENT, id);
}

/** Whole records (metadata + content), newest first — for callers that need
    every byte (backup export). */
export async function loadAllBooks(): Promise<BookRecord[]> {
  const db = await open();
  const tx = db.transaction([BOOKS, BOOK_CONTENT]);
  const metas = await tx.objectStore(BOOKS).getAll();
  const out: BookRecord[] = [];
  for (const stored of metas) {
    const { meta, content } = splitBook(stored);
    const loaded = content ?? (await tx.objectStore(BOOK_CONTENT).get(meta.id));
    out.push({ ...meta, ...(loaded ?? { chapters: [] }) });
  }
  await tx.done;
  return out.sort((a, b) => b.addedAt - a.addedAt);
}

/** Store a whole book: the shelf record and its content, atomically. */
export async function putBook(record: BookRecord): Promise<void> {
  const db = await open();
  const { meta, content } = splitBook(record);
  const tx = db.transaction([BOOKS, BOOK_CONTENT], "readwrite");
  await Promise.all([
    tx.objectStore(BOOKS).put(meta),
    tx.objectStore(BOOK_CONTENT).put(content ?? { chapters: [] }, meta.id),
    tx.done,
  ]);
}

export async function saveProgress(id: string, progress: number): Promise<void> {
  const db = await open();
  const record = await db.get(BOOKS, id);
  if (record) {
    record.progress = progress;
    record.lastReadAt = Date.now();
    await db.put(BOOKS, record);
  }
}

export async function restoreBookProgress(
  id: string,
  progress: number,
  lastReadAt?: number,
): Promise<void> {
  const db = await open();
  const record = await db.get(BOOKS, id);
  if (!record) return;
  record.progress = Math.min(1, Math.max(0, progress));
  record.lastReadAt = lastReadAt;
  await db.put(BOOKS, record);
}

export async function deleteBook(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([BOOKS, BOOK_CONTENT], "readwrite");
  await Promise.all([
    tx.objectStore(BOOKS).delete(id),
    tx.objectStore(BOOK_CONTENT).delete(id),
    tx.done,
  ]);
  await deleteManga(id);
}

export async function updateBookMeta(
  id: string,
  patch: Partial<
    Pick<
      Book,
      | "title"
      | "author"
      | "cover"
      | "contentHash"
      | "lastReadAt"
      | "format"
      | "series"
      | "volumeIndex"
      | "favorite"
    >
  >,
): Promise<void> {
  const db = await open();
  const record = await db.get(BOOKS, id);
  if (record) {
    Object.assign(record, patch);
    await db.put(BOOKS, record);
  }
}
