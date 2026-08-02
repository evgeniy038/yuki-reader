// Cancel-race regression: delete a volume WHILE its OCR is running and prove
// the deleted UUID leaves no storage rows and never resurrects (a late
// putMangaVolume `.then(trackMangaOcr)` or a trackMangaOcr resumed after its
// storage reads must not revive a tracked row or a queue for a dead UUID).
// Then re-import the SAME fixture — book ids are crypto.randomUUID(), so the
// re-import is a NEW id (contentHash is only duplicate metadata): assert the
// new UUID differs, reaches detection progress with no old-id rows, and
// deletes cleanly too.
//
// Generic on purpose: no manga path/title/page count is hardcoded — the
// volume is discovered in IndexedDB as "the manga book that just appeared".
//
// Fixture (exactly one volume), same knobs as ocr-bench:
//   YUKI_BENCH_ZIP          path to a .zip/.cbz archive of page scans
//   YUKI_BENCH_DIR          path to a folder of loose page scans
//   YUKI_TEST_BASE          server URL (default http://localhost:1420)
//   YUKI_BENCH_PROFILE_DIR  persistent chromium profile (unset = fresh temp;
//                           a warm profile skips the model download)
//
// The server is NOT started here — run `pnpm dev` (or preview) first.
//
//   YUKI_BENCH_ZIP=/path/vol.zip pnpm tsx tests/ocr-cancel-race.ts

import { readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
const ZIP = process.env.YUKI_BENCH_ZIP;
const DIR = process.env.YUKI_BENCH_DIR;
const PROFILE_DIR = process.env.YUKI_BENCH_PROFILE_DIR;
/** How long to sample storage after a delete (old active workers settle). */
const SETTLE_MS = 20_000;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

function resolveInputs(): string[] {
  if (ZIP) return [ZIP];
  if (DIR) {
    const files = readdirSync(DIR)
      .filter((name) => IMAGE_EXT.test(name))
      .map((name) => join(DIR, name));
    if (files.length === 0) throw new Error(`no images in ${DIR}`);
    return files;
  }
  throw new Error("set YUKI_BENCH_ZIP or YUKI_BENCH_DIR");
}

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out (${timeoutMs / 1000}s) waiting for ${what}`);
}

/** Clear ONLY the result stores on an existing DB; never create the DB on a
    cold profile (an empty v1 DB would skip store creation), never touch
    ocrModels (model cache) or localStorage. */
async function clearResults(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "yuki")) return "cold-no-db";
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const targets = ["books", "manga", "mangaPages", "mangaOcr"].filter((s) =>
      db.objectStoreNames.contains(s),
    );
    if (targets.length > 0) {
      const tx = db.transaction(targets, "readwrite");
      for (const s of targets) tx.objectStore(s).clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    db.close();
    return `cleared:${targets.join(",")}`;
  });
}

interface Rows {
  books: number;
  manga: number;
  mangaPages: number;
  mangaOcr: number;
}

const totalRows = (rows: Rows): number =>
  rows.books + rows.manga + rows.mangaPages + rows.mangaOcr;

/** Row counts for ONE uuid across all four stores, straight from IndexedDB
    (books/manga keyed by id; mangaPages/mangaOcr keyed `${id}/<page>`). */
async function rowsFor(page: Page, uuid: string): Promise<Rows> {
  return page.evaluate(async (id) => {
    const empty = { books: 0, manga: 0, mangaPages: 0, mangaOcr: 0 };
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "yuki")) return empty;
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stores = ["books", "manga", "mangaPages", "mangaOcr"];
    if (stores.some((store) => !db.objectStoreNames.contains(store))) {
      db.close();
      return empty;
    }
    const prefix = `${id}/`;
    const tx = db.transaction(stores);
    const bookReq = tx.objectStore("books").count(id);
    const mangaReq = tx.objectStore("manga").count(id);
    const pageReq = tx.objectStore("mangaPages").getAllKeys();
    const ocrReq = tx.objectStore("mangaOcr").getAllKeys();
    const [books, manga, pageKeys, ocrKeys] = await Promise.all([
      new Promise<number>((resolve, reject) => {
        bookReq.onsuccess = () => resolve(bookReq.result);
        bookReq.onerror = () => reject(bookReq.error);
      }),
      new Promise<number>((resolve, reject) => {
        mangaReq.onsuccess = () => resolve(mangaReq.result);
        mangaReq.onerror = () => reject(mangaReq.error);
      }),
      new Promise<IDBValidKey[]>((resolve, reject) => {
        pageReq.onsuccess = () => resolve(pageReq.result);
        pageReq.onerror = () => reject(pageReq.error);
      }),
      new Promise<IDBValidKey[]>((resolve, reject) => {
        ocrReq.onsuccess = () => resolve(ocrReq.result);
        ocrReq.onerror = () => reject(ocrReq.error);
      }),
    ]);
    const rows = {
      books,
      manga,
      mangaPages: pageKeys.filter((key) => String(key).startsWith(prefix)).length,
      mangaOcr: ocrKeys.filter((key) => String(key).startsWith(prefix)).length,
    };
    db.close();
    return rows;
  }, uuid);
}

/** Every manga book currently in the library (storage truth). */
async function mangaBooks(
  page: Page,
): Promise<{ id: string; pageCount: number }[]> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "yuki")) return [];
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const books = await new Promise<
      { id: string; format?: string; pageCount?: number }[]
    >((resolve, reject) => {
      const r = db.transaction("books").objectStore("books").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return books
      .filter((b) => b.format === "manga")
      .map((b) => ({ id: b.id, pageCount: b.pageCount ?? 0 }));
  });
}

/** Delete the first shelf tile through the real UI (menu → confirm). Works
    for a volume tile and a series tile alike. */
async function deleteFirstTile(page: Page): Promise<void> {
  await page.locator("[data-book-id]").first().click({ button: "right" });
  await page.click("[role=menu] >> text=Delete");
  await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
  await page.click('[role=alertdialog] button:text-is("Delete")');
  await page.waitForTimeout(500);
}

async function checkGone(page: Page, uuid: string, label: string): Promise<void> {
  await waitFor(
    async () => totalRows(await rowsFor(page, uuid)) === 0,
    30_000,
    `${label} storage deletion`,
  );
  const samples: Rows[] = [];
  const settleEnd = Date.now() + SETTLE_MS;
  while (Date.now() < settleEnd) {
    samples.push(await rowsFor(page, uuid));
    await page.waitForTimeout(2_000);
  }
  check(
    samples.every((rows) => totalRows(rows) === 0),
    `${label}: UUID stays absent (${samples.length} samples over ${SETTLE_MS / 1000}s)`,
  );
}

async function main(): Promise<void> {
  const inputs = resolveInputs();
  const up = await fetch(BASE).then(
    (r) => r.ok,
    () => false,
  );
  if (!up) {
    throw new Error(`server not reachable at ${BASE} — start it or set YUKI_TEST_BASE`);
  }

  const userDataDir =
    PROFILE_DIR ?? mkdtempSync(join(tmpdir(), "yuki-cancel-race-"));
  const browser = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    args: [
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = browser.pages()[0] ?? (await browser.newPage());
  let pageError: string | null = null;
  page.on("pageerror", (err) => {
    if (pageError === null) pageError = err.message;
  });

  // Clean result stores on the same origin BEFORE the app loads (guarded so
  // a cold profile is never corrupted); the model cache survives.
  await page.goto(`${BASE}/ocr-models/vocab.txt`);
  const clearOutcome = await clearResults(page);
  await page.goto(BASE);
  await page.waitForSelector('input[accept*=".zip"]', {
    state: "attached",
    timeout: 30_000,
  });
  console.log(
    `[cancel-race] ${ZIP ? "zip" : "dir"} (${inputs.length} files) | base ${BASE} | profile ${PROFILE_DIR ? "persistent" : "fresh"} | clear=${clearOutcome}`,
  );

  // --- delete before volume persistence / the delayed track callback settles --
  await page.setInputFiles('input[accept*=".zip"]', inputs);
  let books = await mangaBooks(page);
  await waitFor(
    async () => {
      books = await mangaBooks(page);
      return books.length === 1;
    },
    120_000,
    "exactly one manga book in the library",
    10,
  );
  const id1 = books[0]!.id;
  await page.locator("[data-book-id]").first().waitFor({ timeout: 10_000 });
  console.log(
    `[cancel-race] imported ${id1} (${books[0]!.pageCount} pages) — deleting before delayed track settles`,
  );
  await deleteFirstTile(page);
  check(
    (await page.locator("[data-book-id]").count()) === 0,
    "early-delete tile leaves the shelf",
  );
  await checkGone(page, id1, "early delete");

  // --- re-import with a NEW uuid, then delete while OCR is active --------------
  await page.setInputFiles('input[accept*=".zip"]', inputs);
  let id2 = "";
  await waitFor(
    async () => {
      const reimported = await mangaBooks(page);
      if (reimported.length !== 1) return false;
      id2 = reimported[0]!.id;
      return true;
    },
    120_000,
    "the re-imported volume",
  );
  check(id2 !== id1, "re-import gets a NEW UUID (ids are never reused)");
  const staleSamples: Rows[] = [];
  let progress = await rowsFor(page, id2);
  await waitFor(
    async () => {
      staleSamples.push(await rowsFor(page, id1));
      progress = await rowsFor(page, id2);
      return progress.mangaOcr >= 1;
    },
    300_000,
    "detection progress on the new UUID",
  );
  check(
    progress.mangaOcr >= 1,
    `new UUID reaches detection progress (mangaOcr=${progress.mangaOcr})`,
  );
  check(
    staleSamples.every((rows) => totalRows(rows) === 0),
    `old UUID has no rows while the new volume's OCR runs (${staleSamples.length} polls)`,
  );

  console.log(
    `[cancel-race] OCR active on new UUID (mangaOcr=${progress.mangaOcr}) — deleting mid-run`,
  );
  await deleteFirstTile(page);
  await checkGone(page, id2, "mid-OCR delete");
  check(
    (await page.locator("[data-book-id]").count()) === 0,
    "shelf empty at the end",
  );
  check(
    pageError === null,
    pageError === null ? "no page errors" : `page error: ${pageError}`,
  );

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nOCR CANCEL RACE: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nOCR CANCEL RACE: PASS");
}

try {
  await main();
} catch (err) {
  console.error(
    `\nOCR CANCEL RACE: FAIL — ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}
