// Facade over the storage/ modules: IndexedDB schema + open() live in
// storage/db.ts, and the per-store record types and functions live in
// storage/books.ts, storage/manga.ts, storage/dictionaries.ts and
// storage/stats.ts. Import paths of existing consumers stay unchanged.

export type { BookContent, BookRecord } from "./storage/books";
export {
  deleteBook,
  loadAllBooks,
  loadBookContent,
  loadShelfBooks,
  putBook,
  restoreBookProgress,
  saveProgress,
  updateBookMeta,
} from "./storage/books";

export type { MangaOcrRecord, MangaRecord } from "./storage/manga";
export {
  OCR_ENGINE,
  deleteManga,
  hasOcrModel,
  loadManga,
  loadMangaOcr,
  loadMangaOcrFlags,
  loadMangaOcrPage,
  loadMangaPageBlob,
  loadOcrModel,
  mergeMangaOcrBlock,
  putMangaOcrDetect,
  putMangaOcrFinal,
  putMangaOcrRecords,
  putMangaVolume,
  putOcrModel,
} from "./storage/manga";

export {
  deleteDictionary,
  loadAllDictionaries,
  loadDictionaryArchives,
  loadDictionaryEntries,
  replaceDictionary,
  setDictionaryEnabled,
  setDictionaryOrder,
} from "./storage/dictionaries";

export { addStatsDelta, loadBookStats, loadStats, putStatsDay } from "./storage/stats";
