import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  importDictionaryArchive,
  type DictionaryRecord,
} from "./dictionaries";
import {
  deleteManga,
  loadAllBooks,
  loadAllDictionaries,
  loadDictionaryArchives,
  loadManga,
  loadMangaOcr,
  loadMangaPageBlob,
  loadStats,
  putBook,
  putMangaOcrRecords,
  putMangaVolume,
  putStatsDay,
  restoreBookProgress,
  type BookRecord,
  type DailyStats,
  type MangaOcrRecord,
  type MangaRecord,
} from "./storage";

export interface BackupOptions {
  books: boolean;
  progress: boolean;
  stats: boolean;
  settings: boolean;
  dictionaries: boolean;
}

export const DEFAULT_BACKUP_OPTIONS: BackupOptions = {
  books: true,
  progress: true,
  stats: true,
  settings: true,
  dictionaries: true,
};

interface ResourceRef {
  path: string;
  mime: string;
  file: string;
}

interface SerializedBookRecord
  extends Omit<BookRecord, "resources" | "pdfBytes"> {
  resources?: ResourceRef[];
  pdfFile?: string;
}

interface MangaBackup {
  record: MangaRecord;
  pages: { file: string; mime: string }[];
  ocr: { page: number; file: string }[];
}

interface BackupBook {
  id: string;
  recordFile: string;
  mangaFile?: string;
}

interface BackupProgress {
  id: string;
  contentHash?: string;
  progress: number;
  lastReadAt?: number;
}

interface BackupDictionary {
  record: DictionaryRecord;
  archiveFile: string;
}

interface BackupManifest {
  format: "yuki-backup";
  version: 1;
  createdAt: number;
  options: BackupOptions;
  books?: BackupBook[];
  progress?: BackupProgress[];
  statsFile?: string;
  settingsFile?: string;
  dictionaries?: BackupDictionary[];
}

const SETTINGS_KEYS = [
  "yuki-lang",
  "yuki:reading",
  "yuki:stats-goal",
  "yuki-shelf-sort",
  "yuki-shelf-collapsed",
] as const;

function json(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value));
}

function readJson<T>(files: Record<string, Uint8Array>, path: string): T {
  if (!safePath(path)) throw new Error(`Backup contains an unsafe file path: ${path}`);
  const bytes = files[path];
  if (!bytes) throw new Error(`Backup is missing ${path}`);
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    throw new Error(`Backup contains invalid JSON: ${path}`);
  }
}

function safePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.includes("\\")
  );
}

function bytesAt(files: Record<string, Uint8Array>, path: unknown): Uint8Array {
  if (!safePath(path) || !files[path]) throw new Error(`Backup contains an unsafe file path: ${path}`);
  return files[path]!;
}

function pageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      avif: "image/avif",
      bmp: "image/bmp",
    } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}

function localSettings(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const result: Record<string, string> = {};
  for (const key of SETTINGS_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

function restoreLocalSettings(settings: Record<string, string>): void {
  if (typeof window === "undefined") return;
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    if (typeof value === "string") window.localStorage.setItem(key, value);
  }
}

function noProgress(record: BookRecord): SerializedBookRecord {
  const { resources: _resources, pdfBytes: _pdfBytes, ...rest } = record;
  const result: SerializedBookRecord = { ...rest, progress: 0 };
  delete result.lastReadAt;
  return result;
}

export async function exportBackup(
  requested: Partial<BackupOptions> = {},
): Promise<Blob> {
  const options = { ...DEFAULT_BACKUP_OPTIONS, ...requested };
  const files: Record<string, Uint8Array> = {};
  const manifest: BackupManifest = {
    format: "yuki-backup",
    version: 1,
    createdAt: Date.now(),
    options,
  };

  const records = await loadAllBooks();
  if (options.books) {
    manifest.books = [];
    for (const record of records) {
      const recordFile = `books/${record.id}.json`;
      const serialized = options.progress
        ? (() => {
            const { resources: _resources, pdfBytes: _pdfBytes, ...rest } = record;
            return { ...rest } as SerializedBookRecord;
          })()
        : noProgress(record);
      const resourceRefs: ResourceRef[] = [];
      for (const [index, resource] of (record.resources ?? []).entries()) {
        const file = `books/${record.id}/resources/${index}.bin`;
        files[file] = resource.bytes;
        resourceRefs.push({ path: resource.path, mime: resource.mime, file });
      }
      if (resourceRefs.length > 0) serialized.resources = resourceRefs;
      if (record.pdfBytes) {
        serialized.pdfFile = `books/${record.id}/book.pdf`;
        files[serialized.pdfFile] = record.pdfBytes;
      }

      const item: BackupBook = { id: record.id, recordFile };
      if (record.format === "manga") {
        const manga = await loadManga(record.id);
        if (manga) {
          const pages: MangaBackup["pages"] = [];
          for (const [index, page] of manga.pages.entries()) {
            const blob = await loadMangaPageBlob(record.id, index);
            if (!blob) throw new Error(`Manga page ${record.id}/${index} is missing`);
            const file = `books/${record.id}/pages/${index}.bin`;
            files[file] = new Uint8Array(await blob.arrayBuffer());
            pages.push({ file, mime: blob.type || pageMime(page.path) });
          }
          const ocr: MangaBackup["ocr"] = [];
          for (const [pageIndex, ocrRecord] of await loadMangaOcr(record.id)) {
            const file = `books/${record.id}/ocr/${pageIndex}.json`;
            files[file] = json(ocrRecord);
            ocr.push({ page: pageIndex, file });
          }
          const mangaFile = `books/${record.id}/manga.json`;
          files[mangaFile] = json({ record: manga, pages, ocr });
          item.mangaFile = mangaFile;
        }
      }
      files[recordFile] = json(serialized);
      manifest.books.push(item);
    }
  } else if (options.progress) {
    manifest.progress = records.map((record) => ({
      id: record.id,
      ...(record.contentHash ? { contentHash: record.contentHash } : {}),
      progress: record.progress,
      ...(record.lastReadAt ? { lastReadAt: record.lastReadAt } : {}),
    }));
  }

  if (options.stats) {
    manifest.statsFile = "stats.json";
    files[manifest.statsFile] = json(await loadStats());
  }
  if (options.settings) {
    manifest.settingsFile = "settings.json";
    files[manifest.settingsFile] = json(localSettings());
  }
  if (options.dictionaries) {
    const dictionaries = await loadAllDictionaries();
    const archives = new Map(
      (await loadDictionaryArchives()).map((archive) => [archive.id, archive.bytes]),
    );
    manifest.dictionaries = [];
    for (const record of dictionaries) {
      const archive = archives.get(record.id);
      if (!archive) continue;
      const archiveFile = `dictionaries/${record.id}.zip`;
      files[archiveFile] = archive;
      manifest.dictionaries.push({ record, archiveFile });
    }
  }

  files["manifest.json"] = json(manifest);
  return new Blob([zipSync(files) as BlobPart], { type: "application/zip" });
}

function validateManifest(value: unknown): asserts value is BackupManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid yuki backup");
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== "yuki-backup" || manifest.version !== 1) {
    throw new Error("Unsupported yuki backup version");
  }
  if (!manifest.options || typeof manifest.options !== "object") {
    throw new Error("Backup options are missing");
  }
}

function readBookRecord(
  files: Record<string, Uint8Array>,
  item: BackupBook,
  includeProgress: boolean,
): BookRecord {
  const serialized = readJson<SerializedBookRecord>(files, item.recordFile);
  if (!serialized || typeof serialized.id !== "string" || typeof serialized.title !== "string") {
    throw new Error(`Invalid book record: ${item.id}`);
  }
  if (serialized.id !== item.id) throw new Error(`Book id mismatch: ${item.id}`);
  const { resources: resourceRefs = [], pdfFile, ...rest } = serialized;
  const record: BookRecord = {
    ...rest,
    resources: resourceRefs.map((resource) => ({
      path: resource.path,
      mime: resource.mime,
      bytes: bytesAt(files, resource.file),
    })),
  };
  if (pdfFile) record.pdfBytes = bytesAt(files, pdfFile);
  if (!includeProgress) {
    record.progress = 0;
    delete record.lastReadAt;
  }
  return record;
}

export interface BackupImportSummary {
  books: number;
  progress: number;
  stats: number;
  dictionaries: number;
}

export async function importBackup(file: Blob): Promise<BackupImportSummary> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const manifest = readJson<BackupManifest>(files, "manifest.json");
  validateManifest(manifest);
  const summary: BackupImportSummary = {
    books: 0,
    progress: 0,
    stats: 0,
    dictionaries: 0,
  };

  // ponytail: restore sequentially; stage into a temporary database only if
  // all-or-nothing recovery becomes necessary after real failure reports.
  if (manifest.books) {
    for (const item of manifest.books) {
      const record = readBookRecord(files, item, manifest.options.progress);
      await deleteManga(record.id);
      await putBook(record);
      if (item.mangaFile) {
        const manga = readJson<MangaBackup>(files, item.mangaFile);
        if (!manga?.record || !Array.isArray(manga.pages)) {
          throw new Error(`Invalid manga record: ${item.id}`);
        }
        const blobs = manga.pages.map((page) =>
          new Blob([bytesAt(files, page.file) as BlobPart], {
            type: page.mime || "application/octet-stream",
          }),
        );
        await putMangaVolume(manga.record, blobs);
        const ocr = new Map<number, MangaOcrRecord>();
        for (const item of manga.ocr ?? []) {
          ocr.set(item.page, readJson<MangaOcrRecord>(files, item.file));
        }
        await putMangaOcrRecords(record.id, ocr);
      }
      summary.books += 1;
    }
  }

  if (manifest.progress) {
    const existing = await loadAllBooks();
    for (const item of manifest.progress) {
      const target = existing.find(
        (book) =>
          book.id === item.id ||
          (item.contentHash !== undefined && book.contentHash === item.contentHash),
      );
      if (!target) continue;
      await restoreBookProgress(target.id, item.progress, item.lastReadAt);
      summary.progress += 1;
    }
  } else if (manifest.books && manifest.options.progress) {
    summary.progress = manifest.books.length;
  }

  if (manifest.statsFile) {
    const stats = readJson<DailyStats[]>(files, manifest.statsFile);
    if (!Array.isArray(stats)) throw new Error("Invalid stats in backup");
    for (const day of stats) {
      if (!day || typeof day.date !== "string") continue;
      await putStatsDay(day);
      summary.stats += 1;
    }
  }

  if (manifest.settingsFile) {
    restoreLocalSettings(readJson<Record<string, string>>(files, manifest.settingsFile));
  }

  for (const item of manifest.dictionaries ?? []) {
    const archive = bytesAt(files, item.archiveFile);
    await importDictionaryArchive(archive, {
      id: item.record.id,
      sourceUrl: item.record.sourceUrl,
      enabled: item.record.enabled,
      order: item.record.order,
    });
    summary.dictionaries += 1;
  }

  return summary;
}
