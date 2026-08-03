import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  BackupCancelledError,
  exportBackupInProcess,
  importBackupInProcess,
  type BackupOperationProgress,
} from "../src/core/backup.ts";
import {
  deleteBook,
  loadAllBooks,
  loadMangaOcr,
  loadMangaPageBlob,
  loadStats,
  putBook,
  putMangaOcrRecords,
  putMangaVolume,
  putStatsDay,
  restoreBookProgress,
  type BookRecord,
} from "../src/core/storage.ts";

// Backup round-trip against an in-memory IndexedDB: full export/import,
// validate-before-write on corrupt archives, progress-only and ttsu imports.

function seedBook(id: string, over: Partial<BookRecord> = {}): BookRecord {
  return {
    id,
    title: `Title ${id}`,
    progress: 0,
    chapters: [{ id: "c1", title: "Chapter 1", html: "<p>text</p>" }],
    addedAt: 1000,
    ...over,
  };
}

const findBook = async (id: string) =>
  (await loadAllBooks()).find((book) => book.id === id);

// --- Seed: epub with a resource, a PDF, a manga volume, one stats day. ------
await putBook(
  seedBook("a", {
    progress: 0.42,
    lastReadAt: 2000,
    contentHash: "hash-a",
    format: "epub",
    bookCss: "p{}",
    resources: [
      { path: "OEBPS/img.jpg", mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
    ],
  }),
);
await putBook(
  seedBook("b", {
    format: "pdf",
    pdfBytes: new Uint8Array([9, 8, 7]),
    pageCount: 3,
  }),
);
await putBook(seedBook("m", { format: "manga", series: "Series", volumeIndex: 1 }));
await putMangaVolume({ id: "m", pages: [{ path: "001.jpg" }, { path: "002.jpg" }] }, [
  new Blob(["page-0"]),
  new Blob(["page-1"]),
]);
await putMangaOcrRecords("m", new Map([[0, { blocks: [], engine: 1 }]]));
await putStatsDay({ date: "2026-08-01", chars: 100, pages: 2, timeMs: 30000 });

// --- 1. Full export → mutate the library → import restores everything. ------
const full = await exportBackupInProcess({}, { "yuki-lang": "en" });
await restoreBookProgress("a", 0);
await deleteBook("b");

const summary = await importBackupInProcess(full);
assert.equal(summary.books, 3);
assert.equal(summary.progress, 3);
assert.equal(summary.stats, 1);
assert.equal(summary.settings?.["yuki-lang"], "en");

const restoredA = (await findBook("a"))!;
assert.equal(restoredA.progress, 0.42);
assert.equal(restoredA.lastReadAt, 2000);
assert.deepEqual([...(restoredA.resources?.[0]?.bytes ?? [])], [1, 2, 3]);

const restoredB = (await findBook("b"))!;
assert.deepEqual([...(restoredB.pdfBytes ?? [])], [9, 8, 7]);
assert.equal(restoredB.progress, 0);

const page0 = await loadMangaPageBlob("m", 0);
assert.ok(page0);
assert.equal(await page0.text(), "page-0");
assert.equal((await loadMangaOcr("m")).size, 1);
const day = (await loadStats()).find((entry) => entry.date === "2026-08-01");
assert.equal(day?.chars, 100);

// --- 2. Corrupt archive: rejects before writing, library untouched. ---------
await restoreBookProgress("a", 0.9);
const files = unzipSync(new Uint8Array(await full.arrayBuffer()));
delete files["books/a/resources/0.bin"];
const damaged = new Blob([zipSync(files)]);
await assert.rejects(importBackupInProcess(damaged), /unsafe file path/);
assert.equal((await findBook("a"))?.progress, 0.9);
assert.ok(await findBook("b"));

// --- 3. Invalid progress entry: rejects, no NaN can reach the library. ------
const badProgress = new Blob([
  zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        format: "yuki-backup",
        version: 1,
        createdAt: 1,
        options: {
          books: false,
          progress: true,
          stats: false,
          settings: false,
          dictionaries: false,
        },
        progress: [{ id: "a", progress: null }],
      }),
    ),
  }),
]);
await assert.rejects(importBackupInProcess(badProgress), /Invalid progress entry/);
assert.equal((await findBook("a"))?.progress, 0.9);

// --- 4. Progress-only backup matches a re-added book by content hash. -------
await restoreBookProgress("a", 0.77);
const progressOnly = await exportBackupInProcess({
  books: false,
  stats: false,
  settings: false,
  dictionaries: false,
});
await deleteBook("a");
await putBook(seedBook("a-copy", { title: "Title a", contentHash: "hash-a" }));
await importBackupInProcess(progressOnly);
assert.equal((await findBook("a-copy"))?.progress, 0.77);

// --- 5. ttsu backup: progress and statistics matched by book title. ---------
const ttsu = new Blob([
  zipSync({
    "Title a/progress_1.json": strToU8(
      JSON.stringify({ progress: 0.66, lastBookmarkModified: 5000 }),
    ),
    "statistics/statistics_1.json": strToU8(
      JSON.stringify([
        {
          title: "Title a",
          dateKey: "2026-08-02",
          charactersRead: 250,
          readingTime: 60,
        },
      ]),
    ),
  }),
]);
const ttsuSummary = await importBackupInProcess(ttsu);
assert.equal(ttsuSummary.progress, 1);
assert.equal(ttsuSummary.stats, 1);
const ttsuTarget = (await findBook("a-copy"))!;
assert.equal(ttsuTarget.progress, 0.66);
assert.equal(ttsuTarget.lastReadAt, 5000);
const ttsuDay = (await loadStats()).find((entry) => entry.date === "2026-08-02");
assert.equal(ttsuDay?.chars, 250);
assert.equal(ttsuDay?.timeMs, 60000);
assert.equal(ttsuDay?.perBook?.["a-copy"]?.chars, 250);

// --- 6. Books exported without progress come back at zero. ------------------
const noProgress = await exportBackupInProcess({ progress: false });
await importBackupInProcess(noProgress);
const resetA = (await findBook("a-copy"))!;
assert.equal(resetA.progress, 0);
assert.equal(resetA.lastReadAt, undefined);

// --- 7. Garbage input: rejects instead of crashing with raw zip errors. -----
await assert.rejects(importBackupInProcess(new Blob(["not a zip"])));

// --- 8. Export cancel: lands between manga pages, nothing is produced. ------
// Manga "m" has 2 pages; cancel when the first page event arrives — the
// second page must never be packed.
const exportEvents: BackupOperationProgress[] = [];
const exportToken = { cancelled: false };
await assert.rejects(
  exportBackupInProcess(
    {},
    {},
    (progress) => {
      exportEvents.push(progress);
      if (progress.item?.kind === "page" && progress.item.index === 1) {
        exportToken.cancelled = true;
      }
    },
    exportToken,
  ),
  (error) => error instanceof BackupCancelledError,
);
// Granular progress really flows: a book item event and per-page events with
// real indexes/counts — not a bare spinner.
assert.ok(
  exportEvents.some((event) => event.item?.kind === "book" && event.item.index === 1),
);
const pageEvents = exportEvents.filter((event) => event.item?.kind === "page");
// Exactly one page event: the second page was never packed after the cancel.
assert.equal(pageEvents.length, 1);
assert.equal(pageEvents[0]?.item?.index, 1);
assert.equal(pageEvents[0]?.item?.count, 2);

// --- 9. Import cancel: lands between books, library stays consistent. -------
// Fresh books with a strict recency order (export walks recent-first: z, y, x).
await putBook(seedBook("x", { progress: 0.1, addedAt: 8_000 }));
await putBook(seedBook("y", { progress: 0.2, addedAt: 9_000 }));
await putBook(seedBook("z", { progress: 0.3, addedAt: 10_000 }));
const orderCheck = await exportBackupInProcess(
  { stats: false, settings: false, dictionaries: false },
  {},
);
await restoreBookProgress("x", 0);
await restoreBookProgress("y", 0);
await restoreBookProgress("z", 0);
const importToken = { cancelled: false };
let importCancelError: unknown;
try {
  await importBackupInProcess(
    orderCheck,
    (progress) => {
      // The first restored book is committed; cancel right after — the next
      // book must never be touched.
      if (progress.phase === "restore" && progress.current === 1) {
        importToken.cancelled = true;
      }
    },
    importToken,
  );
  assert.fail("import should have been cancelled");
} catch (cause) {
  importCancelError = cause;
}
assert.ok(importCancelError instanceof BackupCancelledError);
assert.equal((importCancelError as BackupCancelledError).summary?.books, 1);
assert.equal((await findBook("z"))?.progress, 0.3); // first book restored
assert.equal((await findBook("y"))?.progress, 0); // untouched
assert.equal((await findBook("x"))?.progress, 0); // untouched

// --- 10. Pre-cancelled token: import aborts before writing anything. --------
const beforeY = (await findBook("y"))?.progress;
await assert.rejects(
  importBackupInProcess(orderCheck, undefined, { cancelled: true }),
  (error) => error instanceof BackupCancelledError,
);
assert.equal((await findBook("z"))?.progress, 0.3);
assert.equal((await findBook("y"))?.progress, beforeY);

// --- 11. Export progress is page-granular: the bar moves with real work. ----
// Books in the library now: a, b, m (manga, 2 pages), x, y, z → 6 book units
// + 2 page units + stats + settings = 10 total. A whole manga used to count
// as one unit, freezing the bar at 0% for the entire export.
const progressEvents: BackupOperationProgress[] = [];
await exportBackupInProcess({}, {}, (event) => progressEvents.push(event));
const prepareEvents = progressEvents.filter((event) => event.phase === "prepare");
const lastPrepare = prepareEvents.at(-1)!;
assert.equal(lastPrepare.total, 10);
assert.equal(lastPrepare.current, 10);
// The manga's second page event must already carry an advanced counter — not
// the frozen per-book value that kept the bar at 0%.
const pageTwo = prepareEvents.find(
  (event) => event.item?.kind === "page" && event.item.index === 2,
);
assert.ok(pageTwo, "expected a page-2 progress event");
assert.ok(pageTwo.current > 0, "page work must advance the export counter");

console.log("Backup round-trip smoke: PASS");
