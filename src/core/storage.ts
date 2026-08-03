import { openDB, unwrap, type DBSchema } from "idb";
import type { BookFormat, Language } from "./library";
import type { MokuroBlock } from "./mokuro";
import type { Chapter, EpubResource, TocEntry } from "./reading";
import type { MangaStoredPage } from "./import-manga";
import type {
  DictionaryArchiveRecord,
  DictionaryEntryRecord,
  DictionaryRecord,
} from "./dictionaries";
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
  /** Exact float detector rects ([x1,y1,x2,y2], aligned with `blocks`;
      `blocks[].box` stays rounded for the overlay) so recognition reuses
      the detector's crops. Absent on legacy records — full detect then. */
  crops?: number[][];
}

/** Cached OCR model file (downloaded once, reused forever). */
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
  dictionaries: { key: string; value: DictionaryRecord };
  dictionaryEntries: {
    key: string;
    value: DictionaryEntryRecord;
    indexes: {
      byDictionaryTerm: [string, string];
    };
  };
  dictionaryArchives: { key: string; value: DictionaryArchiveRecord };
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
const DICTIONARIES = "dictionaries";
const DICTIONARY_ENTRIES = "dictionaryEntries";
const DICTIONARY_ARCHIVES = "dictionaryArchives";
const BY_DICTIONARY_TERM = "byDictionaryTerm";

let dbPromise: ReturnType<typeof openDB<YukiDB>> | null = null;

// A schema upgrade waits for every other connection (another tab) to close;
// if a tab hangs on to an old version, openDB would pend FOREVER — no event,
// no error, just silence. Bound the wait and fail loudly instead; the next
// call retries from scratch (dbPromise is reset on rejection).
const DB_OPEN_TIMEOUT_MS = 15_000;

function open() {
  if (!dbPromise) {
    const request = openDB<YukiDB>(DB_NAME, 7, {
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
        // v7: Yomitan-compatible dictionaries. Archives are kept so a
        // portable backup can restore the exact imported package; parsed term
        // rows make lookups cheap without unzipping on every hover.
        if (oldVersion < 7) {
          if (!db.objectStoreNames.contains(DICTIONARIES)) {
            db.createObjectStore(DICTIONARIES, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(DICTIONARY_ENTRIES)) {
            const entries = db.createObjectStore(DICTIONARY_ENTRIES, {
              keyPath: "key",
            });
            entries.createIndex(BY_DICTIONARY_TERM, [
              "dictionaryId",
              "termKey",
            ]);
          }
          if (!db.objectStoreNames.contains(DICTIONARY_ARCHIVES)) {
            db.createObjectStore(DICTIONARY_ARCHIVES, { keyPath: "id" });
          }
        }
      },
    });
    dbPromise = Promise.race([
      request,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "The library database is locked by another tab — close other yuki tabs and retry",
              ),
            ),
          DB_OPEN_TIMEOUT_MS,
        ),
      ),
    ]);
    dbPromise.catch(() => {
      // Let the next call retry instead of caching a dead promise forever.
      dbPromise = null;
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

// OCR writes are atomic at the storage boundary: every write opens the manga
// store in the SAME readwrite transaction as the OCR store, serializing with
// deleteManga — a deleted volume can never be resurrected by a late worker
// result (the write sees the manga row gone and skips). A detect skeleton
// never downgrades a final record; a block fill merges inside the
// transaction so concurrent fills of different blocks never clobber.

/** Detect skeleton: final boxes, empty lines, plus the exact float crop
    rects (`crops`, aligned with `blocks`) so the recognition march reuses
    them without a second detector pass. Returns false when the volume is
    gone or the page already holds a final record (never downgrade it). */
export async function putMangaOcrDetect(
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
  crops: number[][],
): Promise<boolean> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  const manga = await tx.objectStore(MANGA).get(bookId);
  const store = tx.objectStore(MANGA_OCR);
  const key = `${bookId}/${pageIndex}`;
  const existing: MangaOcrRecord | undefined = manga
    ? await store.get(key)
    : undefined;
  if (!manga || (existing?.engine === OCR_ENGINE && !existing.partial)) {
    await tx.done;
    return false;
  }
  await store.put({ blocks, crops, engine: OCR_ENGINE, partial: true }, key);
  await tx.done;
  return true;
}

/** Final recognition result for a page. Returns false when the volume is
    gone (deleted/cancelled mid-flight — the result is dropped, not written). */
export async function putMangaOcrFinal(
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
): Promise<boolean> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  const manga = await tx.objectStore(MANGA).get(bookId);
  if (!manga) {
    await tx.done;
    return false;
  }
  await tx
    .objectStore(MANGA_OCR)
    .put({ blocks, engine: OCR_ENGINE }, `${bookId}/${pageIndex}`);
  await tx.done;
  return true;
}

/** Fill ONE block of a skeleton record (hover lazy-OCR), atomically merging
    into the current record so concurrent fills are never lost. No-op once
    the page is final or the volume is gone. Returns the stored record (the
    unchanged one when it was already final), or null when there is nothing
    to fill. */
export async function mergeMangaOcrBlock(
  bookId: string,
  pageIndex: number,
  blockIndex: number,
  block: MokuroBlock,
): Promise<MangaOcrRecord | null> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  const manga = await tx.objectStore(MANGA).get(bookId);
  const store = tx.objectStore(MANGA_OCR);
  const key = `${bookId}/${pageIndex}`;
  const existing: MangaOcrRecord | undefined = manga
    ? await store.get(key)
    : undefined;
  if (!existing || existing.engine !== OCR_ENGINE) {
    await tx.done;
    return null;
  }
  if (!existing.partial || blockIndex < 0 || blockIndex >= existing.blocks.length) {
    await tx.done;
    return existing;
  }
  const blocks = existing.blocks.slice();
  blocks[blockIndex] = block;
  const done = blocks.every((b) => b.lines.length > 0);
  const record: MangaOcrRecord = {
    blocks,
    engine: OCR_ENGINE,
    ...(existing.crops ? { crops: existing.crops } : {}),
    ...(done ? {} : { partial: true }),
  };
  await store.put(record, key);
  await tx.done;
  return record;
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

// --- Dictionaries ---------------------------------------------------------

export async function loadAllDictionaries(): Promise<DictionaryRecord[]> {
  const db = await open();
  return (await db.getAll(DICTIONARIES)).sort((a, b) => a.order - b.order);
}

export async function loadDictionaryArchive(
  id: string,
): Promise<Uint8Array | undefined> {
  const db = await open();
  return (await db.get(DICTIONARY_ARCHIVES, id))?.bytes;
}

export async function loadDictionaryEntries(
  dictionaryId: string,
  termKey: string,
): Promise<DictionaryEntryRecord[]> {
  const db = await open();
  return db.getAllFromIndex(
    DICTIONARY_ENTRIES,
    BY_DICTIONARY_TERM,
    IDBKeyRange.only([dictionaryId, termKey]),
  );
}

export async function replaceDictionary(
  record: DictionaryRecord,
  archive: Uint8Array,
  entries: DictionaryEntryRecord[],
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const db = await open();
  const tx = db.transaction(
    [DICTIONARIES, DICTIONARY_ENTRIES, DICTIONARY_ARCHIVES],
    "readwrite",
  );
  const entriesStore = tx.objectStore(DICTIONARY_ENTRIES);
  const index = entriesStore.index(BY_DICTIONARY_TERM);
  let cursor = await index.openCursor(IDBKeyRange.bound([record.id, ""], [record.id, "\uffff"]));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.objectStore(DICTIONARIES).put(record);
  await tx.objectStore(DICTIONARY_ARCHIVES).put({ id: record.id, bytes: archive });
  onProgress?.(0, entries.length);
  const rawEntriesStore = unwrap(entriesStore);
  const reportEvery = Math.max(1, Math.ceil(entries.length / 50));
  for (const [index, entry] of entries.entries()) {
    rawEntriesStore.put(entry);
    if (
      (index + 1) % reportEvery === 0 &&
      index + 1 < entries.length
    ) {
      onProgress?.(index + 1, entries.length);
    }
  }
  await tx.done;
  const completed = entries.length || 1;
  onProgress?.(completed, completed);
}

export async function deleteDictionary(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(
    [DICTIONARIES, DICTIONARY_ENTRIES, DICTIONARY_ARCHIVES],
    "readwrite",
  );
  await tx.objectStore(DICTIONARIES).delete(id);
  await tx.objectStore(DICTIONARY_ARCHIVES).delete(id);
  const index = tx.objectStore(DICTIONARY_ENTRIES).index(BY_DICTIONARY_TERM);
  let cursor = await index.openCursor(IDBKeyRange.bound([id, ""], [id, "\uffff"]));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function setDictionaryEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  const db = await open();
  const record = await db.get(DICTIONARIES, id);
  if (!record) return;
  record.enabled = enabled;
  await db.put(DICTIONARIES, record);
}

export async function setDictionaryOrder(ids: string[]): Promise<void> {
  const db = await open();
  const tx = db.transaction(DICTIONARIES, "readwrite");
  for (const [order, id] of ids.entries()) {
    const record = await tx.store.get(id);
    if (record) await tx.store.put({ ...record, order });
  }
  await tx.done;
}

export async function loadDictionaryArchives(): Promise<DictionaryArchiveRecord[]> {
  const db = await open();
  return db.getAll(DICTIONARY_ARCHIVES);
}

export async function putMangaOcrRecords(
  bookId: string,
  records: Map<number, MangaOcrRecord>,
): Promise<void> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  if (!(await tx.objectStore(MANGA).get(bookId))) {
    await tx.done;
    return;
  }
  const store = tx.objectStore(MANGA_OCR);
  for (const [pageIndex, record] of records) {
    await store.put(
      { ...record, engine: OCR_ENGINE },
      `${bookId}/${pageIndex}`,
    );
  }
  await tx.done;
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

export async function putStatsDay(day: DailyStats): Promise<void> {
  const db = await open();
  await db.put(STATS, day);
}
