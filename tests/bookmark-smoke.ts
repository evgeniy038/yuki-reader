// Bookmark + peek-visit checker: drives the dwell model in headless Chrome.
//   Context 1 (bookmark): import → flip 3 pages FAST → exit → reopen lands on
//     page 1 (no 3s dwell anywhere → the bookmark never moved) → flip deep →
//     dwell 3.5s → exit → reopen lands exactly on the dwelled page.
//   Context 2 (peek visit): import → one flip → exit after ~2s → stats view
//     shows zeros: sessions under the 10s warmup never reach the log.
// Usage: pnpm tsx tests/bookmark-smoke.ts [title substring, or YUKI_TEST_EPUB_FILTER]

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const FILTER = process.argv[2] ?? requireEnv("YUKI_TEST_EPUB_FILTER");
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

// The reader chrome auto-hides when idle and only reveals near the top edge
// (clientY < 40) — wake it with a mouse move there before clicking.
async function exitToShelf(page: Page): Promise<void> {
  await page.mouse.move(720, 10);
  await page.waitForTimeout(300);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
}

async function reopenBook(page: Page): Promise<void> {
  await page.locator("[data-book-id]").first().click();
  await page.waitForSelector(".book-content", { timeout: 30_000 });
  // Let the paginator measure + restore before reading the indicator.
  await page.waitForTimeout(1_200);
}

const currentPage = async (page: Page): Promise<number> =>
  Number(await page.locator("[data-page-indicator]").getAttribute("data-page"));

async function main(): Promise<void> {
  const file = readdirSync(NOVELS_DIR).find(
    (f) => f.toLowerCase().endsWith(".epub") && f.includes(FILTER),
  );
  if (!file) throw new Error(`no epub matching "${FILTER}" in ${NOVELS_DIR}`);
  const epubPath = join(NOVELS_DIR, file);

  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  // Context 1: the bookmark moves only after a 3s dwell on a page.
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.setInputFiles('input[accept*="epub"]', epubPath);
    await page.waitForSelector(".book-content", { timeout: 60_000 });
    await page.waitForTimeout(600); // let the paginator measure
    // Fast flips: nothing is dwelled on (every gap is well under 3s), so the
    // bookmark must stay at the start of the book.
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("ArrowLeft"); // vertical: ArrowLeft = next page
      await page.waitForTimeout(200);
    }
    await exitToShelf(page);
    await reopenBook(page);
    check(
      (await currentPage(page)) === 1,
      "fast flipping leaves the bookmark at page 1",
    );
    // Dwell: turn deep enough for real text, then stay 3.5s on the page.
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(3_500);
    const dwelled = await currentPage(page);
    check(dwelled > 1, `the dwell happened inside the book (page ${dwelled})`);
    await exitToShelf(page);
    await reopenBook(page);
    check(
      (await currentPage(page)) === dwelled,
      `reopen restores the dwelled page (${dwelled})`,
    );
    await context.close();
  }

  // Context 2: a peek visit (well under the 10s warmup) writes no stats.
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.setInputFiles('input[accept*="epub"]', epubPath);
    await page.waitForSelector(".book-content", { timeout: 60_000 });
    await page.waitForTimeout(500);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(800); // ~2s inside: no dwell, no heartbeat tick
    await exitToShelf(page);
    await page.click('button[data-view="stats"]');
    // Nothing was ever flushed: the stats view stays in its empty state.
    await page.waitForSelector("text=Statistics", { timeout: 10_000 });
    check(
      (await page.locator("text=Nothing to count yet").count()) === 1,
      "peek visit leaves the stats log empty",
    );
    await context.close();
  }

  await browser.close();
  if (problems.length) {
    console.log(`\nbookmark-smoke: ${problems.length} problem(s)`);
    problems.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  console.log("\nbookmark-smoke: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
