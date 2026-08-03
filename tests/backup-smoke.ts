// Backup transfer checker: drives the real Settings UI in headless Chrome on
// REAL books (a novel + a 47 MB manga volume from the fixtures). Flow:
// import both via the shelf → read the novel so it has progress → export
// dialog: granular per-page progress, cancel mid-export (clean reset, no
// download) → full export → verify the ZIP byte-level in Node → fresh
// profile: import round-trip (books + manga pages + progress back) → corrupt
// archive rejected before any write → cancel mid-import returns to idle.
// Usage: YUKI_TEST_EPUB_DIR=... YUKI_TEST_MANGA_DIR=... pnpm tsx tests/backup-smoke.ts

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright-core";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const MANGA_DIR = requireEnv("YUKI_TEST_MANGA_DIR");
const FILTER = process.env.YUKI_TEST_EPUB_FILTER ?? "キッチン";
const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
const BACKUP_PATH = "/tmp/yuki-backup-smoke.zip";

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

async function ensureServer(): Promise<void> {
  const up = await fetch(BASE).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return;
  const child = spawn("pnpm", ["dev"], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await fetch(BASE).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
  }
  throw new Error(`dev server did not come up on ${BASE}`);
}

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  return context.newPage();
}

async function importFile(page: Page, path: string, cards: number): Promise<void> {
  await page.setInputFiles('input[accept*="epub"]', path);
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-book-id]").length === count,
    cards,
    { timeout: 180_000 },
  );
}

async function main(): Promise<void> {
  const epubFile = readdirSync(NOVELS_DIR).find(
    (f) => f.toLowerCase().endsWith(".epub") && f.includes(FILTER),
  );
  if (!epubFile) throw new Error(`no epub matching "${FILTER}" in ${NOVELS_DIR}`);
  const epubPath = join(NOVELS_DIR, epubFile);
  const mangaFile = readdirSync(join(MANGA_DIR, "kaguya")).find((f) =>
    f.toLowerCase().endsWith(".zip"),
  );
  if (!mangaFile) throw new Error(`no manga zip in ${MANGA_DIR}/kaguya`);
  const mangaPath = join(MANGA_DIR, "kaguya", mangaFile);
  const sourceImages = Object.keys(
    unzipSync(new Uint8Array(readFileSync(mangaPath))),
  ).filter((name) => /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(name));
  console.log(`fixtures: ${epubFile} + ${mangaFile} (${sourceImages.length} pages)`);

  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  // === A. Seed a library with real books, give the novel progress. =========
  const page = await freshPage(browser);
  await page.goto(BASE);
  await importFile(page, epubPath, 1);
  await importFile(page, mangaPath, 2);
  check(true, "novel + manga imported through the shelf UI");

  await page.locator("[data-book-id]", { hasText: FILTER }).first().click();
  await page.waitForSelector(".book-content", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(3_500); // bookmark dwell
  await page.mouse.move(720, 10);
  await page.waitForTimeout(500);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForTimeout(1_000);

  // === B. Export dialog: granular progress + cancel, then the real export. =
  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector("text=Progress", { timeout: 10_000 });
  await page.locator("button", { hasText: "Export progress" }).first().click();
  await page.waitForSelector("[role=dialog]", { timeout: 5_000 });

  let downloadFired = false;
  page.on("download", () => {
    downloadFired = true;
  });

  await page.click('[role=dialog] button:text-is("Export progress")');
  // Per-page detail is the proof the progress is real, not a bare spinner.
  await page.waitForSelector('[role=dialog] >> text=/Page \\d+ of \\d+/', {
    timeout: 60_000,
  });
  check(true, "export shows live per-page progress");
  await page.click('[role=dialog] button:text-is("Cancel")');
  await page.waitForSelector('[role=dialog] input[type="checkbox"], [role=dialog] [role="switch"]', {
    timeout: 10_000,
  });
  check(true, "cancel mid-export returns to the options list");
  await page.waitForTimeout(1_500);
  check(!downloadFired, "cancelled export produced no download");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 300_000 }),
    page.click('[role=dialog] button:text-is("Export progress")'),
  ]);
  await download.saveAs(BACKUP_PATH);
  check(true, "full export downloads the backup ZIP");

  // === C. Byte-level verification of the archive in Node. ==================
  const files = unzipSync(new Uint8Array(readFileSync(BACKUP_PATH)));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as {
    format: string;
    version: number;
    books: { id: string; recordFile: string; mangaFile?: string }[];
  };
  check(manifest.format === "yuki-backup" && manifest.version === 1, "manifest format/version");
  check(manifest.books.length === 2, "archive carries both books");
  const mangaEntry = manifest.books.find((book) => book.mangaFile);
  const packedPages = mangaEntry
    ? Object.keys(files).filter((name) =>
        name.startsWith(`books/${mangaEntry.id}/pages/`),
      )
    : [];
  check(
    packedPages.length === sourceImages.length,
    `manga pages packed 1:1 (${packedPages.length}/${sourceImages.length})`,
  );
  const packedPageBytes = packedPages.reduce(
    (sum, name) => sum + (files[name]?.length ?? 0),
    0,
  );
  check(packedPageBytes > 40_000_000, "page bytes are real, not stubs");

  // === D. Fresh profile: import round-trip restores everything. ============
  const page2 = await freshPage(browser);
  await page2.goto(`${BASE}/#/settings`);
  await page2.waitForSelector("text=Progress", { timeout: 10_000 });
  await page2.evaluate(() => {
    (window as unknown as { __preImport: boolean }).__preImport = true;
  });
  await page2.locator("button", { hasText: "Import progress" }).first().click();
  await page2.setInputFiles('input[accept*=".yuki"]', BACKUP_PATH);
  // The app reloads after a successful import — detect it, don't guess timing.
  await page2.waitForFunction(
    () => !(window as unknown as { __preImport?: boolean }).__preImport,
    { timeout: 300_000, polling: 500 },
  );
  check(true, "import completes and reloads the app");
  await page2.goto(`${BASE}/#/`);
  await page2.waitForFunction(
    () => document.querySelectorAll("[data-book-id]").length === 2,
    { timeout: 30_000 },
  );
  check(true, "both books are back on the shelf");
  const novelText =
    (await page2.locator("[data-book-id]", { hasText: FILTER }).first().textContent()) ?? "";
  check(/%/.test(novelText), "novel reading progress survived the round-trip");
  await page2.locator("[data-book-id]", { hasText: FILTER }).first().click();
  await page2.waitForSelector(".book-content", { timeout: 30_000 });
  check(true, "restored novel opens in the reader");
  await page2.goto(`${BASE}/#/`);
  await page2.waitForSelector("[data-book-id]", { timeout: 10_000 });

  // === E. Corrupt archive: rejected before any write. ======================
  const corruptName = `books/${mangaEntry!.id}/pages/0.bin`;
  const corruptFiles = { ...files };
  delete corruptFiles[corruptName];
  const { zipSync } = await import("fflate");
  const corruptPath = "/tmp/yuki-backup-smoke-corrupt.zip";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(corruptPath, zipSync(corruptFiles));

  const page3 = await freshPage(browser);
  await page3.goto(`${BASE}/#/settings`);
  await page3.waitForSelector("text=Progress", { timeout: 10_000 });
  await page3.locator("button", { hasText: "Import progress" }).first().click();
  await page3.setInputFiles('input[accept*=".yuki"]', corruptPath);
  await page3.waitForSelector('[role=dialog] >> text=Couldn\'t process the progress file', {
    timeout: 60_000,
  });
  check(true, "corrupt archive shows the localized error");
  await page3.goto(`${BASE}/#/`);
  await page3.waitForTimeout(1_500);
  check(
    (await page3.locator("[data-book-id]").count()) === 0,
    "corrupt import wrote nothing (validate-before-write)",
  );

  // === F. Cancel mid-import: the dialog comes back, nothing hangs. =========
  const page4 = await freshPage(browser);
  await page4.goto(`${BASE}/#/settings`);
  await page4.waitForSelector("text=Progress", { timeout: 10_000 });
  await page4.locator("button", { hasText: "Import progress" }).first().click();
  await page4.setInputFiles('input[accept*=".yuki"]', BACKUP_PATH);
  await page4.waitForSelector('[role=dialog] [role="progressbar"]', { timeout: 60_000 });
  await page4.click('[role=dialog] button:text-is("Cancel")');
  // The cancel lands during unpack/first book → back to the dropzone, fast.
  await page4.waitForSelector('[aria-label="Drop backup ZIP here"]', { timeout: 60_000 });
  check(true, "cancel mid-import returns to the dropzone (no hang)");
  await page4.goto(`${BASE}/#/`);
  await page4.waitForTimeout(1_500);
  const partialCards = await page4.locator("[data-book-id]").count();
  check(partialCards <= 1, `at most one book restored after cancel (${partialCards})`);

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nBACKUP CHECK: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nBACKUP CHECK: PASS");
}

await main();
