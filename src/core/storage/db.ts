import { openDB, type DBSchema } from "idb";
import { detectLanguage } from "../library";
import type { DailyStats } from "../stats";
import { splitBook, type BookContent, type StoredBook } from "./books";
import type { MangaOcrRecord, MangaRecord, OcrModelRecord } from "./manga";
import type {
  DictionaryArchiveRecord,
  DictionaryEntryRecord,
  DictionaryRecord,
} from "../dictionaries";

export interface YukiDB extends DBSchema {
  books: { key: string; value: StoredBook };
  bookContent: { key: string; value: BookContent };
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
export const BOOKS = "books";
export const BOOK_CONTENT = "bookContent";
/** Pre-v4 store, gone from the schema: referenced untyped, only to drop it. */
const LEGACY_DICTS = "dicts";
export const STATS = "stats";
export const MANGA = "manga";
export const MANGA_PAGES = "mangaPages";
export const MANGA_OCR = "mangaOcr";
export const OCR_MODELS = "ocrModels";
export const DICTIONARIES = "dictionaries";
export const DICTIONARY_ENTRIES = "dictionaryEntries";
export const DICTIONARY_ARCHIVES = "dictionaryArchives";
export const BY_DICTIONARY_TERM = "byDictionaryTerm";

let dbPromise: ReturnType<typeof openDB<YukiDB>> | null = null;

// A schema upgrade waits for every other connection (another tab) to close;
// if a tab hangs on to an old version, openDB would pend FOREVER — no event,
// no error, just silence. Bound the wait and fail loudly instead; the next
// call retries from scratch (dbPromise is reset on rejection).
const DB_OPEN_TIMEOUT_MS = 15_000;

export function open() {
  if (!dbPromise) {
    const request = openDB<YukiDB>(DB_NAME, 8, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
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
        // v8: book content (chapters, resources, PDF bytes) moves out of the
        // shelf record into its own store, keyed by book id — the shelf
        // reads a few KB per book instead of every byte of every book. One
        // record at a time through a cursor, so memory stays flat however
        // big the library is. The shelf-time backfills (format, language)
        // need the content, so they are settled here once and persisted.
        if (oldVersion < 8) {
          if (!db.objectStoreNames.contains(BOOK_CONTENT)) {
            db.createObjectStore(BOOK_CONTENT);
          }
          const content = transaction.objectStore(BOOK_CONTENT);
          let cursor = await transaction.objectStore(BOOKS).openCursor();
          while (cursor) {
            const { meta, content: payload } = splitBook(cursor.value);
            if (payload) {
              meta.format ??=
                (payload.resources?.length ?? 0) > 0 || payload.bookCss
                  ? "epub"
                  : "pdf";
              meta.language ??= detectLanguage(
                payload.chapters
                  .slice(0, 3)
                  .map((chapter) => chapter.html)
                  .join(""),
              );
              await content.put(payload, meta.id);
              await cursor.update(meta);
            }
            cursor = await cursor.continue();
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
