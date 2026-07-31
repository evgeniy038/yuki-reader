// PDF checker: drives both fixture PDFs through the real shelf UI in headless
// Chrome — a text-layer book (468 pp) and a mixed text/scanned lecture
// (392 pp, the ugly-PDF case): import → cover → spread rendering (two pages
// on wide screens, one on narrow) → whole-page fit → navigation → progress
// on the tile → restore on reopen → details dialog (Pages) → delete.
// Fixtures: YUKI_TEST_PDF_TEXT, YUKI_TEST_PDF_SCAN (see tests/README.md).
// Usage: pnpm tsx tests/pdf-smoke.ts

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { requireEnv } from "./env.ts";

const TEXT_PDF = requireEnv("YUKI_TEST_PDF_TEXT");
const SCAN_PDF = requireEnv("YUKI_TEST_PDF_SCAN");
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

// Ink ratio of an on-screen page canvas: sampled dark-pixel fraction, so the
// metric is independent of canvas size / devicePixelRatio. A blank render
// scores ~0; any real content scores >= ~0.03; dense text ~0.1. With pageNum,
// targets one page of a spread; otherwise the first canvas.
async function canvasInk(
  page: import("playwright-core").Page,
  pageNum?: number,
): Promise<number> {
  return page.evaluate((n) => {
    const c = document.querySelector<HTMLCanvasElement>(
      n == null ? "[data-pdf-page] canvas" : `[data-page-num="${n}"] canvas`,
    );
    if (!c) return -1;
    const ctx = c.getContext("2d");
    if (!ctx) return -1;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const samples = 2000;
    const step = Math.max(4, Math.floor(d.length / 4 / samples) * 4);
    let ink = 0;
    let total = 0;
    for (let i = 0; i < d.length; i += step) {
      total += 1;
      if (d[i]! < 235 || d[i + 1]! < 235 || d[i + 2]! < 235) ink += 1;
    }
    return total > 0 ? ink / total : 0;
  }, pageNum ?? null);
}

async function currentPage(page: import("playwright-core").Page): Promise<number> {
  const attr = await page.locator("[data-page-indicator]").getAttribute("data-page");
  return Number(attr);
}

async function canvasCount(page: import("playwright-core").Page): Promise<number> {
  return page.locator("[data-pdf-page] canvas").count();
}

// Wait until the on-screen canvas shows the requested (first) page: rapid
// navigation queues renders in the pdf.js worker, and the last one lands when
// it lands.
async function settleOnPage(
  page: import("playwright-core").Page,
  expected: number,
): Promise<void> {
  await page.waitForFunction(
    (n) =>
      document.querySelector("[data-pdf-page]")?.getAttribute("data-rendered-page") ===
      String(n),
    expected,
    { timeout: 15_000 },
  );
}

async function flip(page: import("playwright-core").Page, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
  }
}

async function exitToShelf(page: import("playwright-core").Page): Promise<void> {
  await page.mouse.move(640, 10); // cursor to the top edge reveals the chrome
  await page.waitForTimeout(400);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function deleteViaMenu(page: import("playwright-core").Page): Promise<void> {
  await page.click("[data-book-id]", { button: "right" });
  await page.click("[role=menu] >> text=Delete");
  await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
  await page.click('[role=alertdialog] button:text-is("Delete")');
  await page.waitForTimeout(500);
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(BASE);
  // A hostile font-size preset: it must NOT blow PDF pages out of the
  // viewport (font settings don't apply to pages rendered as print images).
  await page.evaluate(() => {
    window.localStorage.setItem(
      "yuki:reading",
      JSON.stringify({ fontFamily: "sans", fontSize: 24 }),
    );
  });
  await page.waitForTimeout(1000);
  // Clean slate.
  while ((await page.locator("[data-book-id]").count()) > 0) {
    await deleteViaMenu(page);
  }

  // --- text-layer book ------------------------------------------------------
  await page.setInputFiles('input[accept*="pdf"]', TEXT_PDF);
  await page.waitForSelector("[data-pdf-page] canvas", { timeout: 60_000 });
  check(true, "the game: import opens the pdf reader");
  await settleOnPage(page, 1);
  check((await currentPage(page)) === 1, "the game: opens on page 1");
  check((await canvasCount(page)) === 1, "the game: cover shows alone");
  check((await canvasInk(page, 1)) > 0.03, "the game: page 1 renders ink");
  const fit = await page.evaluate(() => {
    const host = document.querySelector("[data-pdf-page]");
    if (!host) return { top: -9999, bottom: 99999, vh: 0 };
    const r = host.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  check(
    fit.top >= -1 && fit.bottom <= fit.vh + 1,
    "the game: whole page fits the viewport (no clipping)",
  );

  // Wide viewport → spreads: first flip lands on [2,3].
  await flip(page, 1);
  await settleOnPage(page, 2);
  check((await currentPage(page)) === 2, "the game: first flip lands on page 2");
  check(
    (await page.locator('[data-page-num="2"] canvas').count()) === 1 &&
      (await page.locator('[data-page-num="3"] canvas').count()) === 1,
    "the game: spread shows pages 2 and 3 side by side",
  );
  const spreadFit = await page.evaluate(() => {
    const host = document.querySelector("[data-pdf-page]");
    if (!host) return { left: -9999, right: 99999, vw: 0 };
    const r = host.getBoundingClientRect();
    return { left: r.left, right: r.right, vw: window.innerWidth };
  });
  check(
    spreadFit.left >= -1 && spreadFit.right <= spreadFit.vw + 1,
    "the game: the whole spread fits the viewport",
  );

  await flip(page, 4);
  await settleOnPage(page, 10);
  check((await currentPage(page)) === 10, "the game: flips advance by spread (page 10)");

  // Front matter is sparse — jump deep into body text for the ink check.
  await flip(page, 10);
  await settleOnPage(page, 30);
  check((await currentPage(page)) === 30, "the game: deep navigation reaches page 30");
  check((await canvasInk(page, 30)) > 0.03, "the game: body page renders ink");

  // The bookmark (and with it the tile's percent) commits after a 3s dwell.
  await page.waitForTimeout(3_500);

  await exitToShelf(page);
  const cardText = (await page.locator("[data-book-id]").textContent()) ?? "";
  check(/%/.test(cardText), "the game: tile shows reading percent");
  const coverSrc = await page.locator("[data-book-id] img").getAttribute("src");
  check(coverSrc?.startsWith("data:image/jpeg") ?? false, "the game: cover rendered");

  // Reopen → restore the spread.
  await page.locator("[data-book-id]").click();
  await page.waitForSelector("[data-pdf-page] canvas", { timeout: 30_000 });
  await settleOnPage(page, 30);
  check((await currentPage(page)) === 30, "the game: reopen restores page 30");

  // Narrow viewport (phone-ish) → single page; back to wide → spread again.
  await page.setViewportSize({ width: 520, height: 800 });
  await page.waitForFunction(
    () => document.querySelectorAll("[data-pdf-page] canvas").length === 1,
    { timeout: 10_000 },
  );
  check(true, "the game: narrow viewport shows a single page");
  const singleFit = await page.evaluate(() => {
    const host = document.querySelector("[data-pdf-page]");
    if (!host) return { top: -9999, bottom: 99999, vh: 0 };
    const r = host.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  check(
    singleFit.top >= -1 && singleFit.bottom <= singleFit.vh + 1,
    "the game: single page fits the narrow viewport",
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(
    () => document.querySelectorAll("[data-pdf-page] canvas").length === 2,
    { timeout: 10_000 },
  );
  check(true, "the game: wide viewport restores the spread");

  // Details dialog → "Pages 468".
  await exitToShelf(page);
  await page.locator("[data-book-id]").click({ button: "right" });
  await page.click("[role=menu] >> text=Details");
  await page.waitForSelector("[role=dialog]", { timeout: 5_000 });
  const detailsText = (await page.locator("[role=dialog]").textContent()) ?? "";
  check(
    detailsText.includes("Pages") && detailsText.includes("468"),
    "the game: details show 468 pages",
  );
  check(detailsText.includes("English"), "the game: language sniffed as English");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await deleteViaMenu(page);
  check((await page.locator("[data-book-id]").count()) === 0, "the game: deleted");

  // --- mixed text/scanned pages --------------------------------------------
  await page.setInputFiles('input[accept*="pdf"]', SCAN_PDF);
  await page.waitForSelector("[data-pdf-page] canvas", { timeout: 60_000 });
  check(true, "scan: import opens the pdf reader");
  await settleOnPage(page, 1);
  check((await canvasInk(page, 1)) > 0.03, "scan: page 1 renders ink");

  // Spread [2,3]: page 2 is genuinely blank in the source (verified against
  // ghostscript), page 3 is the big-type title page.
  await flip(page, 1);
  await settleOnPage(page, 2);
  check((await currentPage(page)) === 2, "scan: spread starts at page 2");
  check(
    (await page.locator('[data-page-num="3"] canvas').count()) === 1,
    "scan: title page 3 is on the spread",
  );
  check((await canvasInk(page, 3)) > 0.03, "scan: title page renders ink");

  // Deep jump: an interior study page (dense two-column layout).
  await flip(page, 12);
  await settleOnPage(page, 26);
  check((await currentPage(page)) === 26, "scan: deep navigation reaches page 26");
  check((await canvasInk(page, 26)) > 0.03, "scan: page 26 renders ink");

  await exitToShelf(page);
  await deleteViaMenu(page);
  check((await page.locator("[data-book-id]").count()) === 0, "scan: deleted");

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nPDF CHECK: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nPDF CHECK: PASS");
}

await main();
