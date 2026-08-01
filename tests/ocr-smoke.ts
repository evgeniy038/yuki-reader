// In-app OCR checker: a raw manga archive (no .mokuro sidecar) goes in, the
// background OCR worker must produce real text boxes on the page. Covers the
// whole pipeline end-to-end in headless Chrome: model download (~130MB from
// Hugging Face, first run per fresh profile) → IndexedDB model cache →
// detection → recognition → live overlay in the reader → persistence across
// a reload (the second open reads blocks from IndexedDB, no re-OCR).
// Fixture root: YUKI_TEST_MANGA_DIR, expects <dir>/kaguya/*.zip (raw scans).
// Usage: YUKI_TEST_MANGA_DIR=... pnpm tsx tests/ocr-smoke.ts

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright-core";
import { requireEnv } from "./env.ts";

const MANGA_DIR = requireEnv("YUKI_TEST_MANGA_DIR");
// Point YUKI_TEST_BASE at a `pnpm preview` server to smoke the PROD build
// (then the server must be up already — no auto-spawn).
const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
/** Model download + a page of OCR can take a while on the first run. */
const OCR_TIMEOUT = 300_000;

async function ensureServer(): Promise<void> {
  const up = await fetch(BASE).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return;
  if (process.env.YUKI_TEST_BASE) {
    throw new Error(`no server at ${BASE} (start it yourself, e.g. pnpm preview)`);
  }
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

async function settleOnPage(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (n) =>
      document.querySelector("[data-manga-page]")?.getAttribute("data-manga-page") ===
      String(n),
    expected,
    { timeout: 20_000 },
  );
}

async function openKaguya(page: Page, expectGate = false): Promise<void> {
  await page.locator("[data-book-id]", { hasText: "かぐや様" }).first().click();
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  if (expectGate) {
    // A fresh archive volume is frosted on the shelf while the detect
    // stage runs — no entry until every page has OCR boxes.
    const gatedShown = await page
      .waitForSelector("[data-ocr-gated]", { timeout: 120_000 })
      .then(() => true, () => false);
    check(gatedShown, "gate: volume frosted until pages are scanned");
  }
  // The gated tile is aria-disabled; this click waits the gate out (the
  // first wait includes the model download and the whole detect pass —
  // ~5 min for a 200-page volume with the full detector).
  await page.locator("[data-book-id]").first().click({ timeout: 600_000 });
  await page.waitForSelector("[data-manga-page] img", { timeout: 60_000 });
  await settleOnPage(page, 1);
}

/** How many pages the mangaOcr store holds (across all books). */
async function countOcrPages(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("mangaOcr");
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = tx.objectStore("mangaOcr").getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return keys.length;
  });
}

/** How many pages are fully RECOGNIZED (final record, not a detect
    skeleton). The march rewrites skeletons in place, so the key count
    doesn't move — this is the number that grows. */
async function countRecognizedPages(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("mangaOcr");
    const records = await new Promise<{ partial?: boolean }[]>(
      (resolve, reject) => {
        const r = tx.objectStore("mangaOcr").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      },
    );
    db.close();
    return records.filter((record) => record && !record.partial).length;
  });
}

async function main(): Promise<void> {
  await ensureServer();
  const zipName = readdirSync(join(MANGA_DIR, "kaguya")).find((name) =>
    /\.zip$/i.test(name),
  );
  if (!zipName) throw new Error("no kaguya zip fixture");

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`  [console] ${msg.text()}`);
  });
  await page.goto(BASE);
  await page.waitForTimeout(1000);

  // Import the raw archive: no sidecar anywhere, OCR must fill the gap.
  await page.setInputFiles(
    'input[accept*=".mokuro"]',
    join(MANGA_DIR, "kaguya", zipName),
  );
  await page.waitForSelector('[data-book-id]:has-text("かぐや様")', {
    timeout: 120_000,
  });
  check(true, "import: raw archive becomes a series tile");

  // The queue panel shows the background work (model download, then volumes).
  const pillShown = await page
    .waitForSelector("[data-ocr-status]", { timeout: 60_000 })
    .then(() => true, () => false);
  check(pillShown, "status: the OCR panel appears");
  if (pillShown) {
    console.log(`  · panel: "${(await page.locator("[data-ocr-status]").textContent()) ?? ""}"`);
  }

  // Open the volume once the gate clears (detect pass done).
  await openKaguya(page, true);
  console.log("  · waiting for OCR blocks (model download + first page)…");
  const t0 = Date.now();
  const blocksCame = await page
    .waitForSelector("[data-ocr-block]", { timeout: OCR_TIMEOUT })
    .then(() => true, () => false);
  check(
    blocksCame,
    `ocr: text boxes appear on the page (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );

  if (blocksCame) {
    const blockCount = await page.locator("[data-ocr-block]").count();
    check(blockCount > 0, `ocr: ${blockCount} blocks on page 1 (cover)`);
    await page.locator("[data-ocr-block]").first().hover();
    await page.waitForTimeout(300);
    const hoverOpacity = await page
      .locator("[data-ocr-block] div")
      .first()
      .evaluate((el) => getComputedStyle(el).opacity);
    check(hoverOpacity === "1", "ocr: hover reveals the text");

    // Throughput: the recognition march rewrites detect skeletons into final
    // records IN PLACE, so the sampled number is the growth of recognized
    // (non-partial) pages. Each run job pays for the FULL 43MB detector
    // (~0.7s) plus per-block recognition — ~10-11 pages/min measured on an
    // M3 Pro (the old 12+ guard predates the full detector). The guard
    // catches a catastrophic fallback (broken threads → single-thread wasm,
    // ~830ms/block ≈ 4-5 pages/min), not normal load variance.
    const doneBefore = await countRecognizedPages(page);
    const tBefore = Date.now();
    await page.waitForTimeout(45_000);
    const perMin =
      ((await countRecognizedPages(page)) - doneBefore) /
      ((Date.now() - tBefore) / 60_000);
    check(
      perMin >= 8,
      `throughput: ${perMin.toFixed(1)} pages/min (recognition march)`,
    );
  }

  // Results are persisted: a reload re-opens with blocks from IndexedDB,
  // no second OCR pass (they show up fast — no model wait on this path).
  await page.goto(BASE); // back to the shelf (reload keeps the reader URL)
  await page.waitForSelector("[data-book-id]", { timeout: 30_000 });
  await page.waitForTimeout(500);
  await openKaguya(page);
  const persisted = await page
    .waitForSelector("[data-ocr-block]", { timeout: 60_000 })
    .then(() => true, () => false);
  check(persisted, "persist: blocks survive a reload (read from IndexedDB)");

  // And the mangaOcr store holds entries (not just the live page).
  const stored = await countOcrPages(page);
  check(stored > 0, `persist: mangaOcr store holds ${stored} pages`);

  // The cover carries little text — flip to the first content page (left
  // edge means forward in a manga) and check the recognized text there:
  // it must be real Japanese.
  await page.mouse.click(25, 400);
  await settleOnPage(page, 2);
  const page2Blocks = await page
    .waitForSelector("[data-ocr-block]", { timeout: 60_000 })
    .then(() => true, () => false);
  check(page2Blocks, "ocr: text boxes on the first content page");
  if (page2Blocks) {
    await page.locator("[data-ocr-block]").first().hover();
    const japanese = await page
      .waitForFunction(
        () => {
          const joined = [...document.querySelectorAll("[data-ocr-block]")]
            .map((el) => el.textContent ?? "")
            .join("");
          return (joined.match(/[぀-ヿ一-鿿々〻]/g) ?? []).length >= 4;
        },
        undefined,
        { timeout: 120_000 },
      )
      .then(
        async () => {
          const texts = await page
            .locator("[data-ocr-block]")
            .allTextContents();
          console.log(
            `  · page 2 blocks: ${texts.map((s) => s.trim()).filter(Boolean).slice(0, 6).join(" | ")}`,
          );
          return true;
        },
        () => false,
      );
    check(japanese, "ocr: recognized text is Japanese");
  }

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nOCR CHECK: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nOCR CHECK: PASS");
}

await main();
