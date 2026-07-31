import { openDB, type DBSchema } from "idb";
import type { BookFormat, Language } from "./library";
import type { Chapter, EpubResource, TocEntry } from "./reading";
import {
  applyBookDelta,
  applyDelta,
  dayKey,
  type BookAmount,
  type DailyStats,
  type StatsDelta,
} from "./stats";

export type { BookAmount, DailyStats, StatsDelta } from "./stats";

export interface BookRecord {
  id: string;
  title: string;
  author?: string;
  language?: Language;
  format?: BookFormat;
  progress: number;
  chapters: Chapter[];
  /** Table of contents (EPUB): NCX/nav entries mapped to spine chapter ids. */
  toc?: TocEntry[];
  cover?: string;
  resources?: EpubResource[];
  bookCss?: string;
  /** Raw PDF bytes — the PDF reader renders pages straight from them. */
  pdfBytes?: Uint8Array;
  /** Total pages (PDF only; EPUB length lives in chapters). */
  pageCount?: number;
  /** Content fingerprint for duplicate-import rejection. */
  contentHash?: string;
  addedAt: number;
  /** Last time the book was opened or read. Absent = never opened. */
  lastReadAt?: number;
}

interface YukiDB extends DBSchema {
  books: { key: string; value: BookRecord };
  stats: { key: string; value: DailyStats };
}

const DB_NAME = "yuki";
const BOOKS = "books";
/** Pre-v4 store, gone from the schema: referenced untyped, only to drop it. */
const LEGACY_DICTS = "dicts";
const STATS = "stats";

let dbPromise: ReturnType<typeof openDB<YukiDB>> | null = null;
function open() {
  if (!dbPromise) {
    dbPromise = openDB<YukiDB>(DB_NAME, 4, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1 && !db.objectStoreNames.contains(BOOKS)) {
          db.createObjectStore(BOOKS, { keyPath: "id" });
        }
        if (oldVersion < 3 && !db.objectStoreNames.contains(STATS)) {
          db.createObjectStore(STATS, { keyPath: "date" });
        }
        // v4: dictionaries are out of the app — drop their store. If the
        // feature returns, a dictionary is one re-import away.
        if (
          oldVersion < 4 &&
          (db.objectStoreNames as DOMStringList).contains(LEGACY_DICTS)
        ) {
          (db as unknown as IDBDatabase).deleteObjectStore(LEGACY_DICTS);
        }
      },
    });
  }
  return dbPromise;
}

export async function loadAllBooks(): Promise<BookRecord[]> {
  const db = await open();
  const records = await db.getAll(BOOKS);
  return records.sort((a, b) => b.addedAt - a.addedAt);
}

export async function putBook(record: BookRecord): Promise<void> {
  const db = await open();
  await db.put(BOOKS, record);
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

export async function deleteBook(id: string): Promise<void> {
  const db = await open();
  await db.delete(BOOKS, id);
}

export async function updateBookMeta(
  id: string,
  patch: Partial<
    Pick<BookRecord, "title" | "author" | "cover" | "contentHash" | "lastReadAt" | "format">
  >,
): Promise<void> {
  const db = await open();
  const record = await db.get(BOOKS, id);
  if (record) {
    Object.assign(record, patch);
    await db.put(BOOKS, record);
  }
}

// --- Reading statistics ----------------------------------------------------

/**
 * Merge a reading-session delta into today's record (read-modify-write).
 * The day is stamped at write time — no midnight splitting. With `bookId`
 * the same delta is also attributed to that book's slice of the day.
 */
export async function addStatsDelta(
  delta: StatsDelta,
  bookId?: string,
): Promise<void> {
  const db = await open();
  const key = dayKey(Date.now());
  const current = (await db.get(STATS, key)) ?? {
    date: key,
    chars: 0,
    pages: 0,
    timeMs: 0,
  };
  let next = applyDelta(current, delta);
  if (bookId) next = applyBookDelta(next, bookId, delta);
  await db.put(STATS, next);
}

/** All-time volume of one book: its per-day slices summed. */
export async function loadBookStats(bookId: string): Promise<BookAmount> {
  const db = await open();
  const days = await db.getAll(STATS);
  const total: BookAmount = { chars: 0, pages: 0, timeMs: 0 };
  for (const day of days) {
    const slice = day.perBook?.[bookId];
    if (!slice) continue;
    total.chars += slice.chars;
    total.pages += slice.pages;
    total.timeMs += slice.timeMs;
  }
  return total;
}

export async function loadStats(): Promise<DailyStats[]> {
  const db = await open();
  const days = await db.getAll(STATS);
  return days.sort((a, b) => a.date.localeCompare(b.date));
}
