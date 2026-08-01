import { openDB, type DBSchema } from "idb";
import type { BookFormat, Language } from "./library";
import type { MokuroBlock } from "./mokuro";
import type { Chapter, EpubResource, TocEntry } from "./reading";
import type { MangaStoredPage } from "./import-manga";
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
  /** Manga only: the series this volume belongs to (display name). */
  series?: string;
  /** Manga only: 1-based position inside the series. */
  volumeIndex?: number;
  addedAt: number;
  /** Last time the book was opened or read. Absent = never opened. */
  lastReadAt?: number;
}

/** Manga volume sidecar record: page metadata in reading order. The page
    images themselves live in the pages store (`${id}/${index}` → Blob), so
    progress saves never rewrite megabytes of scans. */
export interface MangaRecord {
  id: string;
  pages: MangaStoredPage[];
}

/** In-app OCR result for one manga page (the app-generated counterpart of a
    .mokuro sidecar page). Keyed `${bookId}/${pageIndex}` like the page blobs. */
export interface MangaOcrRecord {
  blocks: MokuroBlock[];
  /** Pipeline version — a bump re-runs OCR for pages stored by an older one. */
  engine: number;
  /** Detect-only skeletons (lazy OCR): boxes/vertical/font_size are final,
      lines are empty until recognized — on hover, in the reading window, or
      by the background catch-up pass. */
  partial?: boolean;
}

/** Cached OCR model file (downloaded from Hugging Face once, reused forever). */
export interface OcrModelRecord {
  url: string;
  bytes: Uint8Array;
}

interface YukiDB extends DBSchema {
  books: { key: string; value: BookRecord };
  stats: { key: string; value: DailyStats };
  manga: { key: string; value: MangaRecord };
  mangaPages: { key: string; value: Blob };
  mangaOcr: { key: string; value: MangaOcrRecord };
  ocrModels: { key: string; value: OcrModelRecord };
}

const DB_NAME = "yuki";
const BOOKS = "books";
/** Pre-v4 store, gone from the schema: referenced untyped, only to drop it. */
const LEGACY_DICTS = "dicts";
const STATS = "stats";
const MANGA = "manga";
const MANGA_PAGES = "mangaPages";
const MANGA_OCR = "mangaOcr";
const OCR_MODELS = "ocrModels";

let dbPromise: ReturnType<typeof openDB<YukiDB>> | null = null;
function open() {
  if (!dbPromise) {
    dbPromise = openDB<YukiDB>(DB_NAME, 6, {
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
        // v5: manga volumes — page metadata per book id, page blobs under
        // composite `${bookId}/${index}` keys.
        if (oldVersion < 5) {
          if (!db.objectStoreNames.contains(MANGA)) {
            db.createObjectStore(MANGA, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(MANGA_PAGES)) {
            db.createObjectStore(MANGA_PAGES);
          }
        }
        // v6: in-app manga OCR — per-page results (`${bookId}/${pageIndex}`)
        // and the downloaded model files (keyed by their URL).
        if (oldVersion < 6) {
          if (!db.objectStoreNames.contains(MANGA_OCR)) {
            db.createObjectStore(MANGA_OCR);
          }
          if (!db.objectStoreNames.contains(OCR_MODELS)) {
            db.createObjectStore(OCR_MODELS, { keyPath: "url" });
          }
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
  await deleteManga(id);
}

export async function updateBookMeta(
  id: string,
  patch: Partial<
    Pick<
      BookRecord,
      | "title"
      | "author"
      | "cover"
      | "contentHash"
      | "lastReadAt"
      | "format"
      | "series"
      | "volumeIndex"
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

// --- Manga volumes ---------------------------------------------------------

/** Persist a volume: metadata record plus every page blob, atomically. */
export async function putMangaVolume(
  record: MangaRecord,
  blobs: Blob[],
): Promise<void> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_PAGES], "readwrite");
  await tx.objectStore(MANGA).put(record);
  const pages = tx.objectStore(MANGA_PAGES);
  for (let i = 0; i < blobs.length; i++) {
    await pages.put(blobs[i]!, `${record.id}/${i}`);
  }
  await tx.done;
}

export async function loadManga(id: string): Promise<MangaRecord | undefined> {
  const db = await open();
  return db.get(MANGA, id);
}

export async function loadMangaPageBlob(
  id: string,
  index: number,
): Promise<Blob | undefined> {
  const db = await open();
  return db.get(MANGA_PAGES, `${id}/${index}`);
}

/** Drop a volume's metadata, every page blob and its OCR results (id is a
    book id). */
export async function deleteManga(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_PAGES, MANGA_OCR], "readwrite");
  await tx.objectStore(MANGA).delete(id);
  const range = IDBKeyRange.bound(`${id}/`, `${id}/￿`);
  for (const storeName of [MANGA_PAGES, MANGA_OCR] as const) {
    let cursor = await tx.objectStore(storeName).openCursor(range);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

// --- In-app manga OCR --------------------------------------------------------

/** Current OCR pipeline version. Results stored with an older engine are
    treated as missing and re-run. 2 = decoder runaway guard, 3 = lazy OCR
    (detect-only skeleton records + KV-cache merged decoder), 4 = full 43MB
    detector (measured 2x better CER). */
export const OCR_ENGINE = 4;

export async function putMangaOcr(
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
  partial = false,
): Promise<void> {
  const db = await open();
  await db.put(
    MANGA_OCR,
    { blocks, engine: OCR_ENGINE, ...(partial ? { partial: true } : {}) },
    `${bookId}/${pageIndex}`,
  );
}

/** One page's OCR record (blocks + partial flag), or undefined when not
    computed yet (or stale). */
export async function loadMangaOcrPage(
  bookId: string,
  pageIndex: number,
): Promise<MangaOcrRecord | undefined> {
  const db = await open();
  const record = await db.get(MANGA_OCR, `${bookId}/${pageIndex}`);
  return record?.engine === OCR_ENGINE ? record : undefined;
}

/** All OCR'd pages of a volume: page index → record (blocks + partial flag). */
export async function loadMangaOcr(
  bookId: string,
): Promise<Map<number, MangaOcrRecord>> {
  const db = await open();
  const range = IDBKeyRange.bound(`${bookId}/`, `${bookId}/￿`);
  const [keys, records] = await Promise.all([
    db.getAllKeys(MANGA_OCR, range),
    db.getAll(MANGA_OCR, range),
  ]);
  const out = new Map<number, MangaOcrRecord>();
  keys.forEach((key, i) => {
    const record = records[i];
    if (record?.engine !== OCR_ENGINE) return;
    const index = Number(key.slice(key.lastIndexOf("/") + 1));
    if (Number.isFinite(index)) out.set(index, record);
  });
  return out;
}

/** OCR progress flags for a volume, without the block payloads: page index →
    fully recognized. This is what the queue panel counts — cheap to re-read
    after every completed page, so the UI always shows storage truth. */
export async function loadMangaOcrFlags(
  bookId: string,
): Promise<Map<number, boolean>> {
  const db = await open();
  const range = IDBKeyRange.bound(`${bookId}/`, `${bookId}/￿`);
  const [keys, records] = await Promise.all([
    db.getAllKeys(MANGA_OCR, range),
    db.getAll(MANGA_OCR, range),
  ]);
  const out = new Map<number, boolean>();
  keys.forEach((key, i) => {
    const record = records[i];
    if (record?.engine !== OCR_ENGINE) return;
    const index = Number(key.slice(key.lastIndexOf("/") + 1));
    if (Number.isFinite(index)) out.set(index, !record.partial);
  });
  return out;
}

/** Cached OCR model file; undefined when not downloaded yet. */
export async function loadOcrModel(url: string): Promise<Uint8Array | undefined> {
  const db = await open();
  return (await db.get(OCR_MODELS, url))?.bytes;
}

export async function putOcrModel(url: string, bytes: Uint8Array): Promise<void> {
  const db = await open();
  await db.put(OCR_MODELS, { url, bytes });
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
