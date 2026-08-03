import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  DICTIONARIES_CHANGED_EVENT,
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

export type BackupOperationProgressPhase =
  | "prepare"
  | "pack"
  | "unpack"
  | "restore";

export interface BackupOperationProgress {
  phase: BackupOperationProgressPhase;
  current: number;
  total: number;
}

export type BackupOperationProgressListener = (
  progress: BackupOperationProgress,
) => void;

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

export async function exportBackupInProcess(
  requested: Partial<BackupOptions> = {},
  settings: Record<string, string> = localSettings(),
  onProgress?: BackupOperationProgressListener,
): Promise<Blob> {
  const options = { ...DEFAULT_BACKUP_OPTIONS, ...requested };
  const files: Record<string, Uint8Array> = {};
  const manifest: BackupManifest = {
    format: "yuki-backup",
    version: 1,
    createdAt: Date.now(),
    options,
  };

  onProgress?.({ phase: "prepare", current: 0, total: 0 });
  const records = await loadAllBooks();
  const dictionaries = options.dictionaries ? await loadAllDictionaries() : [];
  const total = Math.max(
    1,
    (options.books || options.progress ? records.length : 0) +
      (options.stats ? 1 : 0) +
      (options.settings ? 1 : 0) +
      dictionaries.length,
  );
  let completed = 0;
  onProgress?.({ phase: "prepare", current: completed, total });
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
      completed += 1;
      onProgress?.({ phase: "prepare", current: completed, total });
    }
  } else if (options.progress) {
    manifest.progress = records.map((record) => ({
      id: record.id,
      ...(record.contentHash ? { contentHash: record.contentHash } : {}),
      progress: record.progress,
      ...(record.lastReadAt ? { lastReadAt: record.lastReadAt } : {}),
    }));
    completed += records.length;
    onProgress?.({ phase: "prepare", current: completed, total });
  }

  if (options.stats) {
    manifest.statsFile = "stats.json";
    files[manifest.statsFile] = json(await loadStats());
    completed += 1;
    onProgress?.({ phase: "prepare", current: completed, total });
  }
  if (options.settings) {
    manifest.settingsFile = "settings.json";
    files[manifest.settingsFile] = json(settings);
    completed += 1;
    onProgress?.({ phase: "prepare", current: completed, total });
  }
  if (options.dictionaries) {
    const archives = new Map(
      (await loadDictionaryArchives()).map((archive) => [archive.id, archive.bytes]),
    );
    manifest.dictionaries = [];
    for (const record of dictionaries) {
      const archive = archives.get(record.id);
      if (archive) {
        const archiveFile = `dictionaries/${record.id}.zip`;
        files[archiveFile] = archive;
        manifest.dictionaries.push({ record, archiveFile });
      }
      completed += 1;
      onProgress?.({ phase: "prepare", current: completed, total });
    }
  }

  files["manifest.json"] = json(manifest);
  onProgress?.({ phase: "pack", current: 0, total: 0 });
  const archive = zipSync(files) as BlobPart;
  onProgress?.({ phase: "pack", current: 1, total: 1 });
  return new Blob([archive], { type: "application/zip" });
}

export type BackupWorkerMessage =
  | {
      type: "export";
      options: Partial<BackupOptions>;
      settings: Record<string, string>;
    }
  | { type: "import"; buffer: ArrayBuffer };

export type BackupWorkerResponse =
  | { type: "progress"; progress: BackupOperationProgress }
  | { type: "exported"; buffer: ArrayBuffer }
  | { type: "imported"; summary: BackupImportSummary }
  | { type: "error"; message: string };

function runBackupWorker(
  message: BackupWorkerMessage,
  transfer: Transferable[] = [],
  onProgress?: BackupOperationProgressListener,
): Promise<BackupWorkerResponse> {
  const worker = new Worker(new URL("./backup.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<BackupWorkerResponse>) => {
      if (event.data.type === "progress") {
        onProgress?.(event.data.progress);
        return;
      }
      finish();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Backup worker failed"));
    };
    worker.postMessage(message, transfer);
  });
}

export async function exportBackup(
  requested: Partial<BackupOptions> = {},
  onProgress?: BackupOperationProgressListener,
): Promise<Blob> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return exportBackupInProcess(requested, localSettings(), onProgress);
  }
  const result = await runBackupWorker({
    type: "export",
    options: requested,
    settings: localSettings(),
  }, [], onProgress);
  if (result.type === "error") throw new Error(result.message);
  if (result.type !== "exported") throw new Error("Backup export failed");
  return new Blob([result.buffer], { type: "application/zip" });
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

interface TtsuProgressData {
  progress?: number | string;
  lastBookmarkModified?: number;
}

interface TtsuStatistic {
  title?: string;
  dateKey?: string;
  charactersRead?: number;
  readingTime?: number;
}

function titleKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function ttsuTitle(path: string): string {
  const segment = path.split("/")[0] ?? path;
  try {
    return decodeURIComponent(segment)
      .replaceAll("~ttu-star~", "*")
      .replaceAll("~ttu-dend~", ".")
      .replaceAll("~ttu-spc~", " ");
  } catch {
    return segment;
  }
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function importTtsuBackup(
  files: Record<string, Uint8Array>,
  onProgress?: BackupOperationProgressListener,
): Promise<BackupImportSummary> {
  const progressPaths = Object.keys(files).filter((path) =>
    /(?:^|\/)progress_[^/]+\.json$/i.test(path),
  );
  const statisticsPaths = Object.keys(files).filter((path) =>
    /(?:^|\/)statistics_[^/]+\.json$/i.test(path),
  );
  if (progressPaths.length === 0 && statisticsPaths.length === 0) {
    throw new Error("Unsupported progress file");
  }

  const books = await loadAllBooks();
  const booksByTitle = new Map(books.map((book) => [titleKey(book.title), book]));
  const summary: BackupImportSummary = {
    books: 0,
    progress: 0,
    stats: 0,
    dictionaries: 0,
  };
  const total = Math.max(1, progressPaths.length + statisticsPaths.length);
  let completed = 0;
  onProgress?.({ phase: "restore", current: completed, total });

  for (const path of progressPaths) {
    try {
      const target = booksByTitle.get(titleKey(ttsuTitle(path)));
      if (!target) continue;
      const data = readJson<TtsuProgressData>(files, path);
      const rawProgress = finiteNumber(data.progress);
      if (rawProgress === undefined) continue;
      const progress = rawProgress > 1 ? rawProgress / 100 : rawProgress;
      await restoreBookProgress(target.id, progress, data.lastBookmarkModified);
      summary.progress += 1;
    } finally {
      completed += 1;
      onProgress?.({ phase: "restore", current: completed, total });
    }
  }

  const days = new Map<string, DailyStats>();
  for (const path of statisticsPaths) {
    const raw = readJson<unknown>(files, path);
    const rows = Array.isArray(raw) ? raw : [raw];
    for (const value of rows) {
      if (!value || typeof value !== "object") continue;
      const row = value as TtsuStatistic;
      if (!row.dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(row.dateKey)) continue;
      const chars = Math.max(0, finiteNumber(row.charactersRead) ?? 0);
      const timeMs = Math.max(0, (finiteNumber(row.readingTime) ?? 0) * 1000);
      const day = days.get(row.dateKey) ?? {
        date: row.dateKey,
        chars: 0,
        pages: 0,
        timeMs: 0,
      };
      day.chars += chars;
      day.timeMs += timeMs;
      if (row.title) {
        const target = booksByTitle.get(titleKey(row.title));
        if (target) {
          const perBook = { ...day.perBook };
          const amount = perBook[target.id] ?? { chars: 0, pages: 0, timeMs: 0 };
          perBook[target.id] = {
            chars: amount.chars + chars,
            pages: amount.pages,
            timeMs: amount.timeMs + timeMs,
          };
          day.perBook = perBook;
        }
      }
      days.set(row.dateKey, day);
    }
    completed += 1;
    onProgress?.({ phase: "restore", current: completed, total });
  }
  for (const day of days.values()) {
    await putStatsDay(day);
    summary.stats += 1;
  }
  onProgress?.({ phase: "restore", current: total, total });
  return summary;
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
  settings?: Record<string, string>;
}

export async function importBackupInProcess(
  file: Blob,
  onProgress?: BackupOperationProgressListener,
): Promise<BackupImportSummary> {
  onProgress?.({ phase: "unpack", current: 0, total: 0 });
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  onProgress?.({ phase: "unpack", current: 1, total: 1 });
  if (!files["manifest.json"]) return importTtsuBackup(files, onProgress);
  const manifest = readJson<BackupManifest>(files, "manifest.json");
  validateManifest(manifest);
  const stats = manifest.statsFile
    ? readJson<DailyStats[]>(files, manifest.statsFile)
    : undefined;
  if (stats && !Array.isArray(stats)) throw new Error("Invalid stats in backup");
  const summary: BackupImportSummary = {
    books: 0,
    progress: 0,
    stats: 0,
    dictionaries: 0,
  };
  const restoreTotal = Math.max(
    1,
    (manifest.books?.length ?? 0) +
      (manifest.progress?.length ?? 0) +
      (stats?.length ?? 0) +
      (manifest.settingsFile ? 1 : 0) +
      (manifest.dictionaries?.length ?? 0),
  );
  let restored = 0;
  const reportRestore = () => {
    restored += 1;
    onProgress?.({ phase: "restore", current: restored, total: restoreTotal });
  };
  onProgress?.({ phase: "restore", current: restored, total: restoreTotal });

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
      reportRestore();
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
      if (target) {
        await restoreBookProgress(target.id, item.progress, item.lastReadAt);
        summary.progress += 1;
      }
      reportRestore();
    }
  } else if (manifest.books && manifest.options.progress) {
    summary.progress = manifest.books.length;
  }

  if (stats) {
    for (const day of stats) {
      if (day && typeof day.date === "string") {
        await putStatsDay(day);
        summary.stats += 1;
      }
      reportRestore();
    }
  }

  let settings: Record<string, string> | undefined;
  if (manifest.settingsFile) {
    settings = readJson<Record<string, string>>(files, manifest.settingsFile);
    restoreLocalSettings(settings);
    reportRestore();
  }

  for (const item of manifest.dictionaries ?? []) {
    const archive = bytesAt(files, item.archiveFile);
    const dictionaryStart = restored;
    await importDictionaryArchive(archive, {
      id: item.record.id,
      sourceUrl: item.record.sourceUrl,
      enabled: item.record.enabled,
      order: item.record.order,
    }, (progress) => {
      const fraction =
        progress.total > 0 ? Math.min(1, progress.current / progress.total) : 0;
      onProgress?.({
        phase: "restore",
        current: dictionaryStart + fraction,
        total: restoreTotal,
      });
    });
    summary.dictionaries += 1;
    reportRestore();
  }

  onProgress?.({ phase: "restore", current: restoreTotal, total: restoreTotal });
  return settings ? { ...summary, settings } : summary;
}

export async function importBackup(
  file: Blob,
  onProgress?: BackupOperationProgressListener,
): Promise<BackupImportSummary> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return importBackupInProcess(file, onProgress);
  }
  const buffer = await file.arrayBuffer();
  const result = await runBackupWorker(
    { type: "import", buffer },
    [buffer],
    onProgress,
  );
  if (result.type === "error") throw new Error(result.message);
  if (result.type !== "imported") throw new Error("Backup import failed");
  if (result.summary.settings) restoreLocalSettings(result.summary.settings);
  if (result.summary.dictionaries > 0) {
    window.dispatchEvent(new Event(DICTIONARIES_CHANGED_EVENT));
  }
  return result.summary;
}
