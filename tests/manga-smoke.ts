// Manga checker: drives real manga fixtures through the shelf UI in headless
// Chrome — volumes with OCR sidecars (folder drops) and a raw scan archive
// (zip, junk entries inside): import → series grouping on the shelf → series
// page (vol numbers, add-volume) → RTL reader (single cover, then spreads;
// left means forward) → OCR overlay (hidden until hover, click pins, blocks
// don't flip pages) → progress on the tile → restore on reopen → duplicate
// rejection → rename/delete.
// Fixture root: YUKI_TEST_MANGA_DIR (see tests/README.md), expected layout:
//   <dir>/Oshinoko_2/Oshinoko_02/*.jpg + Oshinoko_02.mokuro
//   <dir>/oshinoko_03/Oshinoko_3/*.jpg + Oshinoko_3.mokuro
//   <dir>/kaguya/*.zip   (one archive of page scans)
// Usage: pnpm tsx tests/manga-smoke.ts

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright-core";
import { requireEnv } from "./env.ts";

const MANGA_DIR = requireEnv("YUKI_TEST_MANGA_DIR");
const BASE = "http://localhost:1420";

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
  throw new Error("dev server did not come up on :1420");
}

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

// All files of a folder-drop volume: the scans plus the sidecar next to them.
function volumeFiles(relDir: string, relMokuro: string): string[] {
  const dir = join(MANGA_DIR, relDir);
  const images = readdirSync(dir)
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .map((name) => join(dir, name));
  return [...images, join(MANGA_DIR, relMokuro)];
}

async function currentPage(page: Page): Promise<number> {
  const attr = await page
    .locator("[data-manga-page]")
    .getAttribute("data-manga-page");
  return Number(attr);
}

async function imageCount(page: Page): Promise<number> {
  return page.locator("[data-manga-page] img").count();
}

// Wait until the reader shows the requested first page — blob loads are async.
async function settleOnPage(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (n) =>
      document.querySelector("[data-manga-page]")?.getAttribute("data-manga-page") ===
      String(n),
    expected,
    { timeout: 20_000 },
  );
}

async function exitToShelf(page: Page): Promise<void> {
  await page.mouse.move(640, 10); // cursor to the top edge reveals the chrome
  await page.waitForTimeout(400);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function deleteFirstTile(page: Page): Promise<void> {
  await page.locator("[data-book-id]").first().click({ button: "right" });
  await page.click("[role=menu] >> text=Delete");
  await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
  await page.click('[role=alertdialog] button:text-is("Delete")');
  await page.waitForTimeout(500);
}

async function seriesTile(page: Page, name: string) {
  return page.locator("[data-book-id]", { hasText: name }).first();
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(1000);
  // Clean slate.
  while ((await page.locator("[data-book-id]").count()) > 0) {
    await deleteFirstTile(page);
  }

  // --- volume with OCR sidecar (folder drop, flattened) ----------------------
  await page.setInputFiles(
    'input[accept*=".mokuro"]',
    volumeFiles("Oshinoko_2/Oshinoko_02", "Oshinoko_2/Oshinoko_02.mokuro"),
  );
  await page.waitForSelector("[data-book-id]", { timeout: 120_000 });
  await page.waitForTimeout(500);
  const oshTile = await seriesTile(page, "Oshinoko");
  check(await oshTile.count(), "ocr: series tile appears on the shelf");
  check(
    ((await oshTile.textContent()) ?? "").includes("1 volume"),
    "ocr: series shows one volume",
  );
  const coverSrc = await oshTile.locator("img").getAttribute("src");
  check(coverSrc?.startsWith("data:image/jpeg") ?? false, "ocr: cover rendered");

  // Series page: one volume, numbered.
  await oshTile.click();
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  check(
    (await page.locator("[data-book-id]").count()) === 1,
    "ocr: series page lists the volume",
  );
  check(
    ((await page.locator("[data-book-id]").first().textContent()) ?? "").includes(
      "Vol 2",
    ),
    "ocr: volume number derived (Vol 2)",
  );

  // Open the volume: the RTL reader, cover alone.
  await page.locator("[data-book-id]").first().click();
  await page.waitForSelector("[data-manga-page] img", { timeout: 60_000 });
  await settleOnPage(page, 1);
  check((await currentPage(page)) === 1, "reader: opens on page 1");
  check((await imageCount(page)) === 1, "reader: cover shows alone");
  const rendered = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>("[data-manga-page] img");
    return img ? img.complete && img.naturalWidth > 0 : false;
  });
  check(rendered, "reader: the scan renders");
  const fit = await page.evaluate(() => {
    const host = document.querySelector("[data-manga-page] img");
    if (!host) return { top: -9999, bottom: 99999, vh: 0 };
    const r = host.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  check(
    fit.top >= -1 && fit.bottom <= fit.vh + 1,
    "reader: whole page fits the viewport",
  );

  // OCR overlay: boxes exist on page 1, hidden until hover, click pins and
  // does NOT flip the page.
  const blockCount = await page.locator("[data-ocr-block]").count();
  check(blockCount > 0, "ocr: text boxes overlay the page");
  const hiddenOpacity = await page
    .locator("[data-ocr-block] div")
    .first()
    .evaluate((el) => getComputedStyle(el).opacity);
  check(hiddenOpacity === "0", "ocr: text hidden at rest");
  await page.locator("[data-ocr-block]").first().hover();
  await page.waitForTimeout(200);
  const hoverOpacity = await page
    .locator("[data-ocr-block] div")
    .first()
    .evaluate((el) => getComputedStyle(el).opacity);
  check(hoverOpacity === "1", "ocr: hover reveals the text");
  await page.locator("[data-ocr-block]").first().click();
  await page.waitForTimeout(200);
  const pinnedOpacity = await page
    .locator("[data-ocr-block] div")
    .first()
    .evaluate((el) => getComputedStyle(el).opacity);
  check(
    pinnedOpacity === "1" && (await currentPage(page)) === 1,
    "ocr: click pins the box without flipping the page",
  );

  // RTL navigation: ArrowLeft goes FORWARD, to the [2,3] spread on wide
  // screens — the earlier page sits on the right.
  await page.keyboard.press("ArrowLeft");
  await settleOnPage(page, 2);
  check((await currentPage(page)) === 2, "reader: left arrow moves forward");
  check((await imageCount(page)) === 2, "reader: spread shows two pages");
  const rtl = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>("[data-manga-page] img")];
    if (imgs.length !== 2) return false;
    const [a, b] = imgs.map((img) => img.getBoundingClientRect().left);
    // DOM order is reading order; flex-row-reverse puts the earlier page right.
    return a! > b!;
  });
  check(rtl, "reader: the earlier page sits on the right (RTL)");
  await page.keyboard.press("ArrowRight");
  await settleOnPage(page, 1);
  check((await currentPage(page)) === 1, "reader: right arrow moves back");
  await page.keyboard.press("ArrowLeft");
  await settleOnPage(page, 2);
  await page.waitForTimeout(3_500); // bookmark dwell

  await exitToShelf(page); // a manga volume exits to its series page
  const volTileText =
    (await page.locator("[data-book-id]").first().textContent()) ?? "";
  check(/%/.test(volTileText), "reader: volume tile shows reading percent");
  await page.click('button[aria-label="Back to the shelf"]'); // → the shelf
  await page.waitForTimeout(500);
  const tileText = (await (await seriesTile(page, "Oshinoko")).textContent()) ?? "";
  check(/%/.test(tileText), "reader: series tile shows reading percent");

  // --- second volume joins the same series ------------------------------------
  await page.setInputFiles(
    'input[accept*=".mokuro"]',
    volumeFiles("oshinoko_03/Oshinoko_3", "oshinoko_03/Oshinoko_3.mokuro"),
  );
  await page.waitForSelector('[data-book-id]:has-text("2 volumes")', {
    timeout: 120_000,
  });
  const oshTile2 = await seriesTile(page, "Oshinoko");
  check(
    ((await oshTile2.textContent()) ?? "").includes("2 volumes"),
    "grouping: second volume joins the series (no duplicate series)",
  );
  await oshTile2.click();
  await page.waitForTimeout(500);
  const volTexts = await page.locator("[data-book-id]").allTextContents();
  check(
    volTexts.some((text) => text.includes("Vol 2")) &&
      volTexts.some((text) => text.includes("Vol 3")),
    "grouping: Vol 2 and Vol 3 under one series",
  );
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForTimeout(500);

  // --- raw scan archive (zip with junk entries) -------------------------------
  const { readdirSync: readDir } = await import("node:fs");
  const zipName = readDir(join(MANGA_DIR, "kaguya")).find((name) =>
    /\.zip$/i.test(name),
  );
  check(zipName !== undefined, "zip: fixture archive found");
  if (zipName) {
    await page.setInputFiles(
      'input[accept*=".mokuro"]',
      join(MANGA_DIR, "kaguya", zipName),
    );
    await page.waitForSelector('[data-book-id]:has-text("かぐや様")', {
      timeout: 120_000,
    });
    const kaguyaTile = await seriesTile(page, "かぐや様");
    check(await kaguyaTile.count(), "zip: archive becomes its own series");
    check(
      ((await kaguyaTile.textContent()) ?? "").includes("1 volume"),
      "zip: one volume from the archive",
    );
    await kaguyaTile.click();
    await page.waitForTimeout(500);
    await page.locator("[data-book-id]").first().click();
    await page.waitForSelector("[data-manga-page] img", { timeout: 60_000 });
    await settleOnPage(page, 1);
    const zipRendered = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>("[data-manga-page] img");
      return img ? img.complete && img.naturalWidth > 0 : false;
    });
    check(zipRendered, "zip: scan page renders (junk entries skipped)");
    check(
      (await page.locator("[data-ocr-block]").count()) === 0,
      "zip: no sidecar, no overlay",
    );
    await exitToShelf(page);

    // Duplicate import: rejected with a notice, no new tile.
    const tileCount = await page.locator("[data-book-id]").count();
    await page.setInputFiles(
      'input[accept*=".mokuro"]',
      join(MANGA_DIR, "kaguya", zipName),
    );
    await page.waitForSelector("text=already in the library", {
      timeout: 120_000,
    });
    check(
      (await page.getByText("already in the library").count()) > 0,
      "zip: duplicate notice shows",
    );
    check(
      (await page.locator("[data-book-id]").count()) === tileCount,
      "zip: duplicate import adds nothing",
    );
  }

  // --- restore + volume delete ------------------------------------------------
  await page.goto(`${BASE}/#/`);
  await page.waitForTimeout(800);
  const oshTile3 = await seriesTile(page, "Oshinoko");
  await oshTile3.click();
  await page.waitForTimeout(500);
  await page
    .locator("[data-book-id]", { hasText: "Vol 2" })
    .first()
    .click();
  await page.waitForSelector("[data-manga-page] img", { timeout: 60_000 });
  await settleOnPage(page, 2);
  check((await currentPage(page)) === 2, "restore: reopen lands on the bookmark");

  // Back to the series page, delete Vol 3.
  await page.mouse.move(640, 10);
  await page.waitForTimeout(400);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page
    .locator("[data-book-id]", { hasText: "Vol 3" })
    .first()
    .click({ button: "right" });
  await page.click("[role=menu] >> text=Delete");
  await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
  await page.click('[role=alertdialog] button:text-is("Delete")');
  await page.waitForTimeout(500);
  const remaining = await page.locator("[data-book-id]").allTextContents();
  check(
    remaining.length === 1 && remaining[0]!.includes("Vol 2"),
    "delete: the volume leaves the series",
  );

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nMANGA CHECK: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nMANGA CHECK: PASS");
}

await main();
