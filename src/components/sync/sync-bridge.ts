import type { Book } from "@/core/library";
import type { MokuroBlock } from "@/core/mokuro";
import {
  loadBookContent,
  loadManga,
  loadMangaOcr,
  loadMangaPageBlob,
  loadStats,
  OCR_ENGINE,
  putMangaOcrRecords,
  restoreBookProgress,
  updateBookMeta,
  type MangaOcrRecord,
} from "@/core/storage";
import type { PackSource } from "@/core/sync/book-pack";
import type { LocalBridge } from "@/core/sync/engine";
import {
  computeBookKeys,
  readSyncedSettings,
  writeSyncedSettings,
  type AppliedSettings,
} from "@/core/sync/local";
import type { BookPatch, LocalBook } from "@/core/sync/merge";
import type { BookKey } from "@/core/sync/model";
import { syncStore } from "@/core/sync/store";
import { catalogOf } from "./sync-catalog";

// The engine's view of the shelf: lean books (from the shelf state the app
// already holds in memory — no IndexedDB scan per round), and the writes a
// merged round asks for, applied to storage AND to the on-screen state so
// nothing has to reload.

/** What the app lends the sync controller. */
export interface SyncHost {
  /** False until the shelf has loaded from storage — no round before that. */
  ready(): boolean;
  books(): Book[];
  /** Mirror applied patches into the on-screen shelf state. */
  patch(patches: BookPatch[]): void;
  /** The shelf's own removal (storage, payload map, OCR queue). */
  remove(ids: string[]): void;
  /** A book that just arrived from the cloud (already in storage). */
  add(book: Book): void;
  settingsApplied(applied: AppliedSettings): void;
}

export function toLocalBook(book: Book, key: BookKey): LocalBook {
  return {
    id: book.id,
    key,
    title: book.title,
    format: book.format,
    progress: book.progress,
    favorite: book.favorite === true,
    ...(book.lastReadAt !== undefined ? { lastReadAt: book.lastReadAt } : {}),
    ...(book.series !== undefined ? { series: book.series } : {}),
    ...(book.volumeIndex !== undefined ? { volumeIndex: book.volumeIndex } : {}),
    ...(book.keepInCloud ? { keep: true } : {}),
  };
}

const sameShelfFields = (a: LocalBook, b: LocalBook): boolean =>
  a.progress === b.progress &&
  a.lastReadAt === b.lastReadAt &&
  a.favorite === b.favorite &&
  a.title === b.title &&
  a.series === b.series &&
  a.volumeIndex === b.volumeIndex &&
  a.keep === b.keep;

/** Storage writes for patches (the on-screen state is the host's job). */
export async function writePatches(patches: BookPatch[], current: Map<string, Book>): Promise<void> {
  for (const patch of patches) {
    const book = current.get(patch.id);
    if (!book) continue;
    if (patch.progress !== undefined) {
      await restoreBookProgress(patch.id, patch.progress, patch.lastReadAt ?? book.lastReadAt);
    }
    const meta: Parameters<typeof updateBookMeta>[1] = {};
    if (patch.lastReadAt !== undefined && patch.progress === undefined) meta.lastReadAt = patch.lastReadAt;
    if (patch.favorite !== undefined) meta.favorite = patch.favorite;
    if (patch.title !== undefined) meta.title = patch.title;
    if (patch.series !== undefined) meta.series = patch.series ?? undefined;
    if (patch.volumeIndex !== undefined) meta.volumeIndex = patch.volumeIndex ?? undefined;
    if (patch.keep !== undefined) meta.keepInCloud = patch.keep;
    if (Object.keys(meta).length > 0) await updateBookMeta(patch.id, meta);
  }
}

// "Is this volume's OCR finished?" reads every page record — answer "not
// yet" from memory for a few minutes instead of re-reading each round.
const OCR_RECHECK_MS = 5 * 60_000;
const unfinishedAt = new Map<string, number>();

async function finishedOcr(id: string): Promise<Map<number, MokuroBlock[]> | null> {
  const seen = unfinishedAt.get(id);
  if (seen !== undefined && Date.now() - seen < OCR_RECHECK_MS) return null;
  const manga = await loadManga(id);
  const needing = (manga?.pages ?? []).flatMap((meta, index) =>
    meta.blocks && meta.blocks.length > 0 ? [] : [index],
  );
  const records = needing.length > 0 ? await loadMangaOcr(id) : new Map<number, MangaOcrRecord>();
  const pages = new Map<number, MokuroBlock[]>();
  for (const index of needing) {
    const record = records.get(index);
    if (record && !record.partial) pages.set(index, record.blocks);
  }
  if (needing.length === 0 || pages.size < needing.length) {
    unfinishedAt.set(id, Date.now());
    return null;
  }
  unfinishedAt.delete(id);
  return pages;
}

/** Another device's OCR lands in storage; this device's OCR queue then skips
    those pages on its own (it re-checks storage before every page). */
async function applyOcr(id: string, pages: Map<number, MokuroBlock[]>): Promise<void> {
  const records = new Map<number, MangaOcrRecord>();
  for (const [index, blocks] of pages) records.set(index, { blocks, engine: OCR_ENGINE });
  await putMangaOcrRecords(id, records);
  unfinishedAt.delete(id);
}

/** A stored book as a pack source (cloud upload or a direct transfer). */
export async function packSourceOf(host: SyncHost, id: string): Promise<PackSource | null> {
  const book = host.books().find((b) => b.id === id);
  if (!book) return null;
  const content = await loadBookContent(id);
  if (!content) return null;
  const record = { ...book, ...content };
  if (book.format !== "manga") return { record };
  const manga = await loadManga(id);
  return manga ? { record, manga: { record: manga, page: (index) => loadMangaPageBlob(id, index) } } : null;
}

export async function createBridge(host: SyncHost): Promise<LocalBridge> {
  const keys = await computeBookKeys(
    host.books().map((book) => book.id),
    await syncStore.bookKeys(),
  );
  await syncStore.setBookKeys(keys);
  const idOfKey = (key: BookKey): string | undefined => {
    for (const [id, k] of keys) if (k === key) return id;
    return undefined;
  };
  return {
    snapshot: async () => ({
      books: host.books().flatMap((book) => {
        const key = keys.get(book.id);
        return key ? [toLocalBook(book, key)] : [];
      }),
      settings: readSyncedSettings((id) => keys.get(id)),
    }),
    apply: async (plan, basis) => {
      // Compare-and-set: a book the reader touched while the round was on
      // the network keeps its fresh value — the next round stamps it and it
      // wins, instead of being overwritten by the older remote one.
      const current = new Map(host.books().map((book) => [book.id, book]));
      const before = new Map(basis.books.map((book) => [book.id, book]));
      const patches = plan.patches.filter((patch) => {
        const now = current.get(patch.id);
        const then = before.get(patch.id);
        return now !== undefined && then !== undefined && sameShelfFields(toLocalBook(now, then.key), then);
      });
      await writePatches(patches, current);
      if (patches.length > 0) host.patch(patches);
      if (plan.deletions.length > 0) host.remove(plan.deletions.map((d) => d.id));
      if (Object.keys(plan.settings).length > 0) {
        host.settingsApplied(writeSyncedSettings(plan.settings, idOfKey));
      }
    },
    localStats: () => loadStats(),
    keyOf: (id) => keys.get(id),
    ocrEngine: OCR_ENGINE,
    finishedOcr,
    applyOcr,
    catalog: () => catalogOf(host.books(), (id) => keys.get(id)),
    packSource: (id) => packSourceOf(host, id),
  };
}
