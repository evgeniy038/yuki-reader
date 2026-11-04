import { mimeFromExtension } from "../mime";
import {
  loadAllDictionaries,
  loadBookContent,
  loadDictionaryArchives,
  loadManga,
  loadMangaOcr,
  loadMangaPageBlob,
  loadShelfBooks,
  loadStats,
  type BookRecord,
  type MangaRecord,
} from "../storage";
import { BackupCancelledError, type BackupCancelToken, type BackupOperationProgressListener } from "../backup";
import {
  createZipArchive,
  json,
  localSettings,
  type BackupBook,
  type BackupManifest,
  type BackupOptions,
  type MangaBackup,
  type ResourceRef,
  type SerializedBookRecord,
} from "./format";

export const DEFAULT_BACKUP_OPTIONS: BackupOptions = {
  books: true,
  progress: true,
  stats: true,
  settings: true,
  dictionaries: true,
};

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

  // Shelf records up front, each book's content only when its turn comes:
  // the export never holds the whole library in memory at once.
  const records = await loadShelfBooks();
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
    for (const [bookIndex, meta] of records.entries()) {
      if (token?.cancelled) throw new BackupCancelledError();
      const record: BookRecord = {
        ...meta,
        ...((await loadBookContent(meta.id)) ?? { chapters: [] }),
      };
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
            pages.push({ file, mime: blob.type || mimeFromExtension(page.path, "application/octet-stream") });
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
