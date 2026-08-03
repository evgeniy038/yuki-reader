import { strFromU8, strToU8, unzipSync, Zip, ZipPassThrough } from "fflate";
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

/** Which item is being processed right now — for the human-facing detail
    line ("Book 3 of 12 · page 145 of 226"), not for the bar. */
export interface BackupOperationItem {
  kind: "book" | "page";
  index: number;
  count: number;
}

export interface BackupOperationProgress {
  phase: BackupOperationProgressPhase;
  current: number;
  total: number;
  item?: BackupOperationItem;
}

export type BackupOperationProgressListener = (
  progress: BackupOperationProgress,
) => void;

/** Cooperative cancellation: checked at item boundaries (between books,
    between manga pages) — never mid-write, so the library stays consistent. */
export interface BackupCancelToken {
  cancelled: boolean;
}

export class BackupCancelledError extends Error {
  /** Set when an import had already restored some items before the cancel. */
  summary?: BackupImportSummary;
  constructor(summary?: BackupImportSummary) {
    super("Backup operation cancelled");
    this.name = "BackupCancelledError";
    this.summary = summary;
  }
}

// The archive is streamed file by file instead of building one giant in-memory
// buffer: each item's bytes are pushed into the zip and released right away,
// so peak memory stays near the archive size instead of several times the
// library. Content is stored uncompressed — books are already-compressed
// formats (EPUB, JPEG, PDF), deflating them again only burns CPU.
function createZipArchive(): {
  add: (name: string, data: Uint8Array) => void;
  finish: () => Promise<Blob>;
} {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  let onFinal: (() => void) | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure = err;
      onFinal?.();
      return;
    }
    chunks.push(chunk);
    if (final) onFinal?.();
  });
  return {
    add(name, data) {
      if (failure) throw failure;
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(data, true);
    },
    finish() {
      return new Promise<Blob>((resolve, reject) => {
        onFinal = () =>
          failure
            ? reject(failure)
            : resolve(new Blob(chunks as BlobPart[], { type: "application/zip" }));
        zip.end();
      });
    },
  };
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

export async function exportBackupInProcess(
  requested: Partial<BackupOptions> = {},
  settings: Record<string, string> = localSettings(),
  onProgress?: BackupOperationProgressListener,
  token?: BackupCancelToken,
): Promise<Blob> {
  const options = { ...DEFAULT_BACKUP_OPTIONS, ...requested };
  const archive = createZipArchive();
  const manifest: BackupManifest = {
    format: "yuki-backup",
    version: 1,
    createdAt: Date.now(),
    options,
  };

  const records = await loadAllBooks();
  const dictionaries = options.dictionaries ? await loadAllDictionaries() : [];
  // The bar must move with the real work: packing a 200-page manga dwarfs a
  // book record, so pages are progress units, not just books. Manga records
  // are loaded once up front and reused by the export loop below.
  const mangaByBookId = new Map<string, MangaRecord>();
  if (options.books) {
    for (const record of records) {
      if (record.format === "manga") {
        const manga = await loadManga(record.id);
        if (manga) mangaByBookId.set(record.id, manga);
      }
    }
  }
  const total = Math.max(
    1,
    (options.books
      ? records.reduce(
          (sum, record) =>
            sum + 1 + (mangaByBookId.get(record.id)?.pages.length ?? 0),
          0,
        )
      : options.progress
        ? records.length
        : 0) +
      (options.stats ? 1 : 0) +
      (options.settings ? 1 : 0) +
      dictionaries.length,
  );
  let completed = 0;
  onProgress?.({ phase: "prepare", current: completed, total });
  if (options.books) {
    manifest.books = [];
    for (const [bookIndex, record] of records.entries()) {
      if (token?.cancelled) throw new BackupCancelledError();
      onProgress?.({
        phase: "prepare",
        current: completed,
        total,
        item: { kind: "book", index: bookIndex + 1, count: records.length },
      });
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
        archive.add(file, resource.bytes);
        resourceRefs.push({ path: resource.path, mime: resource.mime, file });
      }
      if (resourceRefs.length > 0) serialized.resources = resourceRefs;
      if (record.pdfBytes) {
        serialized.pdfFile = `books/${record.id}/book.pdf`;
        archive.add(serialized.pdfFile, record.pdfBytes);
      }

      const item: BackupBook = { id: record.id, recordFile };
      if (record.format === "manga") {
        const manga = mangaByBookId.get(record.id);
        if (manga) {
          const pages: MangaBackup["pages"] = [];
          for (const [index, page] of manga.pages.entries()) {
            if (token?.cancelled) throw new BackupCancelledError();
            onProgress?.({
              phase: "prepare",
              current: completed,
              total,
              item: { kind: "page", index: index + 1, count: manga.pages.length },
            });
            const blob = await loadMangaPageBlob(record.id, index);
            if (!blob) throw new Error(`Manga page ${record.id}/${index} is missing`);
            const file = `books/${record.id}/pages/${index}.bin`;
            archive.add(file, new Uint8Array(await blob.arrayBuffer()));
            pages.push({ file, mime: blob.type || pageMime(page.path) });
            completed += 1;
          }
          const ocr: MangaBackup["ocr"] = [];
          for (const [pageIndex, ocrRecord] of await loadMangaOcr(record.id)) {
            const file = `books/${record.id}/ocr/${pageIndex}.json`;
            archive.add(file, json(ocrRecord));
            ocr.push({ page: pageIndex, file });
          }
          const mangaFile = `books/${record.id}/manga.json`;
          archive.add(mangaFile, json({ record: manga, pages, ocr }));
          item.mangaFile = mangaFile;
        }
      }
      archive.add(recordFile, json(serialized));
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
    archive.add(manifest.statsFile, json(await loadStats()));
    completed += 1;
    onProgress?.({ phase: "prepare", current: completed, total });
  }
  if (options.settings) {
    manifest.settingsFile = "settings.json";
    archive.add(manifest.settingsFile, json(settings));
    completed += 1;
    onProgress?.({ phase: "prepare", current: completed, total });
  }
  if (options.dictionaries) {
    const archives = new Map(
      (await loadDictionaryArchives()).map((archive) => [archive.id, archive.bytes]),
    );
    manifest.dictionaries = [];
    for (const record of dictionaries) {
      const archiveBytes = archives.get(record.id);
      if (archiveBytes) {
        const archiveFile = `dictionaries/${record.id}.zip`;
        archive.add(archiveFile, archiveBytes);
        manifest.dictionaries.push({ record, archiveFile });
      }
      completed += 1;
      onProgress?.({ phase: "prepare", current: completed, total });
    }
  }

  archive.add("manifest.json", json(manifest));
  onProgress?.({ phase: "pack", current: 0, total: 0 });
  const blob = await archive.finish();
  onProgress?.({ phase: "pack", current: 1, total: 1 });
  return blob;
}

export type BackupWorkerMessage =
  | {
      type: "export";
      options: Partial<BackupOptions>;
      settings: Record<string, string>;
    }
  | { type: "import"; buffer: ArrayBuffer }
  | { type: "cancel" };

export type BackupWorkerResponse =
  | { type: "progress"; progress: BackupOperationProgress }
  | { type: "exported"; buffer: ArrayBuffer }
  | { type: "imported"; summary: BackupImportSummary }
  | { type: "cancelled"; summary?: BackupImportSummary }
  | { type: "error"; message: string };

// If the worker goes silent (killed on memory pressure, deadlocked on a
// blocked database) its promise would never settle — without a watchdog the
// dialog would spin forever. Silence longer than this is a hard failure.
const BACKUP_STALL_TIMEOUT_MS = 120_000;

export interface BackupWorkerTask {
  result: Promise<BackupWorkerResponse>;
  /** "terminate" kills the worker outright (export — nothing is written, so
      instant cancel is safe); "cooperative" asks the worker to stop at the
      next item boundary (import — mid-write cancellation must stay atomic). */
  cancel: () => void;
}

function runBackupWorker(
  message: BackupWorkerMessage,
  transfer: Transferable[] = [],
  onProgress?: BackupOperationProgressListener,
  cancelMode: "terminate" | "cooperative" = "cooperative",
): BackupWorkerTask {
  const worker = new Worker(new URL("./backup.worker.ts", import.meta.url), {
    type: "module",
  });
  let cancelRequested = false;
  let rejectResult: ((cause: Error) => void) | null = null;
  let stallTimer: ReturnType<typeof setTimeout>;
  const finish = () => {
    clearTimeout(stallTimer);
    worker.terminate();
  };
  const result = new Promise<BackupWorkerResponse>((resolve, reject) => {
    rejectResult = reject;
    const armWatchdog = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        finish();
        reject(new Error("Backup operation stalled"));
      }, BACKUP_STALL_TIMEOUT_MS);
    };
    worker.onmessage = (event: MessageEvent<BackupWorkerResponse>) => {
      armWatchdog();
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
    armWatchdog();
    worker.postMessage(message, transfer);
  });
  return {
    result,
    cancel: () => {
      if (cancelRequested) return;
      cancelRequested = true;
      if (cancelMode === "terminate") {
        finish();
        rejectResult?.(new BackupCancelledError());
        return;
      }
      worker.postMessage({ type: "cancel" });
    },
  };
}

export interface BackupTask<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function cancelledOrThrow(result: BackupWorkerResponse): void {
  if (result.type === "cancelled") {
    throw new BackupCancelledError(result.summary);
  }
  if (result.type === "error") throw new Error(result.message);
}

export function exportBackupTask(
  requested: Partial<BackupOptions> = {},
  onProgress?: BackupOperationProgressListener,
): BackupTask<Blob> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    const token: BackupCancelToken = { cancelled: false };
    return {
      promise: exportBackupInProcess(requested, localSettings(), onProgress, token),
      cancel: () => {
        token.cancelled = true;
      },
    };
  }
  const task = runBackupWorker(
    { type: "export", options: requested, settings: localSettings() },
    [],
    onProgress,
    "terminate",
  );
  return {
    promise: task.result.then((result) => {
      cancelledOrThrow(result);
      if (result.type !== "exported") throw new Error("Backup export failed");
      return new Blob([result.buffer], { type: "application/zip" });
    }),
    cancel: task.cancel,
  };
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
  token?: BackupCancelToken,
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

  // Parse everything before writing anything: a corrupt file must abort the
  // import before the library changes at all, never halfway through.
  const progressOps: {
    key: string;
    progress: number;
    lastReadAt?: number;
  }[] = [];
  for (const path of progressPaths) {
    const data = readJson<TtsuProgressData>(files, path);
    const rawProgress = finiteNumber(data.progress);
    if (rawProgress === undefined) continue;
    const lastReadAt = finiteNumber(data.lastBookmarkModified);
    progressOps.push({
      key: titleKey(ttsuTitle(path)),
      progress: rawProgress > 1 ? rawProgress / 100 : rawProgress,
      ...(lastReadAt !== undefined ? { lastReadAt } : {}),
    });
  }

  const dayRows: {
    dateKey: string;
    chars: number;
    timeMs: number;
    titleKey?: string;
  }[] = [];
  for (const path of statisticsPaths) {
    const raw = readJson<unknown>(files, path);
    const rows = Array.isArray(raw) ? raw : [raw];
    for (const value of rows) {
      if (!value || typeof value !== "object") continue;
      const row = value as TtsuStatistic;
      if (!row.dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(row.dateKey)) continue;
      dayRows.push({
        dateKey: row.dateKey,
        chars: Math.max(0, finiteNumber(row.charactersRead) ?? 0),
        timeMs: Math.max(0, (finiteNumber(row.readingTime) ?? 0) * 1000),
        ...(row.title ? { titleKey: titleKey(row.title) } : {}),
      });
    }
  }

  const books = await loadAllBooks();
  const booksByTitle = new Map(books.map((book) => [titleKey(book.title), book]));
  const summary: BackupImportSummary = {
    books: 0,
    progress: 0,
    stats: 0,
    dictionaries: 0,
  };
  const total = Math.max(1, progressOps.length + dayRows.length);
  let completed = 0;
  onProgress?.({ phase: "restore", current: completed, total });

  for (const op of progressOps) {
    if (token?.cancelled) throw new BackupCancelledError(summary);
    const target = booksByTitle.get(op.key);
    if (target) {
      await restoreBookProgress(target.id, op.progress, op.lastReadAt);
      summary.progress += 1;
    }
    completed += 1;
    onProgress?.({ phase: "restore", current: completed, total });
  }

  const days = new Map<string, DailyStats>();
  for (const row of dayRows) {
    const day = days.get(row.dateKey) ?? {
      date: row.dateKey,
      chars: 0,
      pages: 0,
      timeMs: 0,
    };
    day.chars += row.chars;
    day.timeMs += row.timeMs;
    if (row.titleKey) {
      const target = booksByTitle.get(row.titleKey);
      if (target) {
        const perBook = { ...day.perBook };
        const amount = perBook[target.id] ?? { chars: 0, pages: 0, timeMs: 0 };
        perBook[target.id] = {
          chars: amount.chars + row.chars,
          pages: amount.pages,
          timeMs: amount.timeMs + row.timeMs,
        };
        day.perBook = perBook;
      }
    }
    days.set(row.dateKey, day);
    completed += 1;
    onProgress?.({ phase: "restore", current: completed, total });
  }
  for (const day of days.values()) {
    if (token?.cancelled) throw new BackupCancelledError(summary);
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

interface PreparedManga {
  record: MangaRecord;
  blobs: Blob[];
  ocr: Map<number, MangaOcrRecord>;
}

interface PreparedRestore {
  books: { record: BookRecord; manga?: PreparedManga }[];
  progress: BackupProgress[];
  stats: DailyStats[];
  settings?: Record<string, string>;
  dictionaries: {
    bytes: Uint8Array;
    meta: {
      id: string;
      sourceUrl?: string;
      enabled: boolean;
      order: number;
    };
  }[];
}

// Parse and validate the whole archive without touching the database. Any
// corruption throws here — before a single byte is restored — so a broken
// backup can never leave the library half-imported.
function prepareRestore(
  files: Record<string, Uint8Array>,
  manifest: BackupManifest,
): PreparedRestore {
  const prepared: PreparedRestore = {
    books: [],
    progress: [],
    stats: [],
    dictionaries: [],
  };

  for (const item of manifest.books ?? []) {
    if (!item || typeof item.id !== "string" || !safePath(item.recordFile)) {
      throw new Error("Invalid book entry in backup");
    }
    const record = readBookRecord(files, item, manifest.options.progress);
    let manga: PreparedManga | undefined;
    if (item.mangaFile) {
      const data = readJson<MangaBackup>(files, item.mangaFile);
      if (!data?.record || !Array.isArray(data.pages)) {
        throw new Error(`Invalid manga record: ${item.id}`);
      }
      manga = {
        record: data.record,
        blobs: data.pages.map(
          (page) =>
            new Blob([bytesAt(files, page.file) as BlobPart], {
              type: page.mime || "application/octet-stream",
            }),
        ),
        ocr: new Map(
          (data.ocr ?? []).map((entry) => [
            entry.page,
            readJson<MangaOcrRecord>(files, entry.file),
          ]),
        ),
      };
    }
    prepared.books.push({ record, manga });
  }

  for (const item of manifest.progress ?? []) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !Number.isFinite(item.progress) ||
      (item.lastReadAt !== undefined && !Number.isFinite(item.lastReadAt))
    ) {
      throw new Error("Invalid progress entry in backup");
    }
    prepared.progress.push(item);
  }

  if (manifest.statsFile) {
    const stats = readJson<DailyStats[]>(files, manifest.statsFile);
    if (!Array.isArray(stats)) throw new Error("Invalid stats in backup");
    prepared.stats = stats.filter(
      (day): day is DailyStats => !!day && typeof day.date === "string",
    );
  }

  if (manifest.settingsFile) {
    prepared.settings = readJson<Record<string, string>>(
      files,
      manifest.settingsFile,
    );
  }

  for (const item of manifest.dictionaries ?? []) {
    if (!item?.record || typeof item.record.id !== "string") {
      throw new Error("Invalid dictionary entry in backup");
    }
    prepared.dictionaries.push({
      bytes: bytesAt(files, item.archiveFile),
      meta: {
        id: item.record.id,
        sourceUrl: item.record.sourceUrl,
        enabled: item.record.enabled,
        order: item.record.order,
      },
    });
  }

  return prepared;
}

export async function importBackupInProcess(
  file: Blob,
  onProgress?: BackupOperationProgressListener,
  token?: BackupCancelToken,
): Promise<BackupImportSummary> {
  onProgress?.({ phase: "unpack", current: 0, total: 0 });
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  onProgress?.({ phase: "unpack", current: 1, total: 1 });
  if (!files["manifest.json"]) return importTtsuBackup(files, onProgress, token);
  const manifest = readJson<BackupManifest>(files, "manifest.json");
  validateManifest(manifest);
  const prepared = prepareRestore(files, manifest);
  const summary: BackupImportSummary = {
    books: 0,
    progress: 0,
    stats: 0,
    dictionaries: 0,
  };
  const restoreTotal = Math.max(
    1,
    prepared.books.length +
      prepared.progress.length +
      prepared.stats.length +
      (prepared.settings ? 1 : 0) +
      prepared.dictionaries.length,
  );
  let restored = 0;
  const reportRestore = (item?: BackupOperationItem) => {
    restored += 1;
    onProgress?.({ phase: "restore", current: restored, total: restoreTotal, ...(item ? { item } : {}) });
  };
  onProgress?.({ phase: "restore", current: restored, total: restoreTotal });

  // ponytail: writes run sequentially; an IndexedDB failure mid-restore can
  // still leave a partial state — stage into a temporary database only if
  // real failure reports show that is necessary.
  for (const [index, item] of prepared.books.entries()) {
    // Cancellation lands between books, never mid-book: the volume write is a
    // single transaction, so the library stays consistent after a cancel.
    if (token?.cancelled) throw new BackupCancelledError(summary);
    await deleteManga(item.record.id);
    await putBook(item.record);
    if (item.manga) {
      await putMangaVolume(item.manga.record, item.manga.blobs);
      await putMangaOcrRecords(item.record.id, item.manga.ocr);
    }
    summary.books += 1;
    reportRestore({ kind: "book", index: index + 1, count: prepared.books.length });
  }

  if (manifest.progress) {
    const existing = await loadAllBooks();
    for (const item of prepared.progress) {
      if (token?.cancelled) throw new BackupCancelledError(summary);
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
  } else if (prepared.books.length > 0 && manifest.options.progress) {
    summary.progress = prepared.books.length;
  }

  for (const day of prepared.stats) {
    if (token?.cancelled) throw new BackupCancelledError(summary);
    await putStatsDay(day);
    summary.stats += 1;
    reportRestore();
  }

  if (prepared.settings) {
    if (token?.cancelled) throw new BackupCancelledError(summary);
    restoreLocalSettings(prepared.settings);
    reportRestore();
  }

  for (const item of prepared.dictionaries) {
    if (token?.cancelled) throw new BackupCancelledError(summary);
    const dictionaryStart = restored;
    await importDictionaryArchive(item.bytes, item.meta, (progress) => {
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
  return prepared.settings ? { ...summary, settings: prepared.settings } : summary;
}

export function importBackupTask(
  file: Blob,
  onProgress?: BackupOperationProgressListener,
): BackupTask<BackupImportSummary> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    const token: BackupCancelToken = { cancelled: false };
    return {
      promise: (async () => {
        const summary = await importBackupInProcess(file, onProgress, token);
        if (summary.dictionaries > 0 && typeof window !== "undefined") {
          window.dispatchEvent(new Event(DICTIONARIES_CHANGED_EVENT));
        }
        return summary;
      })(),
      cancel: () => {
        token.cancelled = true;
      },
    };
  }
  let task: BackupWorkerTask | null = null;
  let cancelRequested = false;
  return {
    promise: (async () => {
      const buffer = await file.arrayBuffer();
      // A cancel clicked while the file was being read (before the worker
      // exists) must not be lost.
      if (cancelRequested) throw new BackupCancelledError();
      task = runBackupWorker({ type: "import", buffer }, [buffer], onProgress);
      if (cancelRequested) task.cancel();
      const result = await task.result;
      cancelledOrThrow(result);
      if (result.type !== "imported") throw new Error("Backup import failed");
      if (result.summary.settings) restoreLocalSettings(result.summary.settings);
      if (result.summary.dictionaries > 0) {
        window.dispatchEvent(new Event(DICTIONARIES_CHANGED_EVENT));
      }
      return result.summary;
    })(),
    cancel: () => {
      cancelRequested = true;
      task?.cancel();
    },
  };
}
