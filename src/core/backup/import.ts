import { unzipSync } from "fflate";
import { importDictionaryArchive } from "../dictionaries";
import {
  deleteManga,
  loadShelfBooks,
  putBook,
  putMangaOcrRecords,
  putMangaVolume,
  putStatsDay,
  restoreBookProgress,
  type BookRecord,
  type MangaOcrRecord,
  type MangaRecord,
} from "../storage";
import type { DailyStats } from "../stats";
import { BackupCancelledError, type BackupCancelToken, type BackupOperationProgressListener } from "../backup";
import {
  bytesAt,
  readJson,
  restoreLocalSettings,
  safePath,
  type BackupBook,
  type BackupManifest,
  type BackupOperationItem,
  type BackupProgress,
  type MangaBackup,
  type SerializedBookRecord,
} from "./format";
import { importTtsuBackup } from "./ttsu";

export function validateManifest(value: unknown): asserts value is BackupManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid yuki backup");
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== "yuki-backup" || manifest.version !== 1) {
    throw new Error("Unsupported yuki backup version");
  }
  if (!manifest.options || typeof manifest.options !== "object") {
    throw new Error("Backup options are missing");
  }
}

export function readBookRecord(
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
export function prepareRestore(
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
    const existing = await loadShelfBooks();
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
