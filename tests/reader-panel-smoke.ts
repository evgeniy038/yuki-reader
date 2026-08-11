// Reader panels + reading theme checker: drives both readers in headless
// Chrome.
//   EPUB: dark theme recolors the page → TOC panel lists entries, a middle
//     entry jumps to its progress → search finds the fixture word, a result
//     jumps to its progress. (EPUB entries show the share of the book in % —
//     the per-section reader has no global page numbers.)
//   PDF: dark theme filters the canvas → outline panel (when the document
//     has one) jumps → text search jumps.
// Usage: pnpm tsx tests/reader-panel-smoke.ts

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { requireEnv } from "./env.ts";
import { clickChromeButton, ensureServer } from "./browser-harness.ts";
import { openFreshTile } from "./import-open.ts";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const EPUB_FILTER = requireEnv("YUKI_TEST_EPUB_FILTER");
const PDF_PATH = requireEnv("YUKI_TEST_PDF_TEXT");
const BASE = "http://localhost:1420";

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

const currentPage = async (page: Page): Promise<number> =>
  Number(await page.locator("[data-page-indicator]").getAttribute("data-page"));

// The indicator's own displayed percent ("16002 / 76407 20.9%").
const currentPercent = async (page: Page): Promise<number> => {
  const text = (await page.locator("[data-page-indicator]").textContent()) ?? "";
  const match = text.match(/([\d.]+)\s*%/);
  return match ? Number(match[1]) : -1;
};

// First page of the spread the PDF reader lands on for `page` (viewport is
// wide enough for spread mode: cover alone, then [2,3], [4,5]…).
const spreadFirstOf = (page: number): number =>
  page <= 1 ? 1 : page % 2 === 0 ? page : page - 1;

async function setDarkTheme(page: Page): Promise<void> {
  await clickChromeButton(page, 'button[aria-label="Settings"]');
  await page.click('button:text-is("Dark")');
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape"); // close the popover
}

async function epubFlow(browser: import("playwright-core").Browser): Promise<void> {
  const file = readdirSync(NOVELS_DIR).find(
    (f) => f.toLowerCase().endsWith(".epub") && f.includes(EPUB_FILTER),
  );
  if (!file) throw new Error(`no epub matching "${EPUB_FILTER}" in ${NOVELS_DIR}`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, file));
  await openFreshTile(page, ".book-content");
  await page.waitForTimeout(1_200); // let the paginator measure + restore

  // Theme: dark recolors the reader surface (#1b1b1d → rgb(27, 27, 29)).
  await setDarkTheme(page);
  const bg = await page.evaluate(() => {
    // .book-content → .reading → scroll box → the themed outer container.
    const el = document.querySelector(".book-content")?.parentElement
      ?.parentElement?.parentElement;
    return el ? getComputedStyle(el).backgroundColor : "";
  });
  check(bg === "rgb(27, 27, 29)", `dark theme recolors the page (${bg})`);

  // TOC: entries listed, a middle one jumps to its progress — a section jump
  // lands exactly on the section start, so the indicator shows the entry's
  // own percent (±1 for rounding).
  await clickChromeButton(page, 'button[aria-label="Contents"]');
  await page.waitForSelector('[data-reader-panel="toc"]', { timeout: 5_000 });
  const entries = page.locator("[data-toc-entry]");
  const entryCount = await entries.count();
  // The fixture's own NCX declares a single title entry — the panel must list
  // what the book declares. Rich-outline jumping is covered by the pdf flow.
  check(entryCount >= 1, `toc lists the book's entries (${entryCount})`);
  const middle = entries.nth(Math.floor(entryCount / 2));
  const tocTarget = Number(
    (await middle.locator(".tabular-nums").textContent())?.replace("%", ""),
  );
  await middle.click();
  await page.waitForTimeout(800);
  const tocPercent = await currentPercent(page);
  check(
    Math.abs(tocPercent - tocTarget) <= 1,
    `toc jump lands at the entry's progress (${tocTarget}% → ${tocPercent}%)`,
  );

  // Search: the filter word is the title word — it must be all over the book.
  // The hit lands on the page containing the match: indicator progress within
  // a couple percent of the hit's own progress (page-top vs in-page offset).
  await clickChromeButton(page, 'button[aria-label="Search in book"]');
  await page.waitForSelector('[data-reader-panel="search"]', { timeout: 5_000 });
  await page.fill('[data-reader-panel="search"] input', EPUB_FILTER);
  await page.waitForSelector("[data-search-result]", { timeout: 10_000 });
  const resultCount = await page.locator("[data-search-result]").count();
  check(resultCount >= 1, `search finds the title word (${resultCount} hits)`);
  const first = page.locator("[data-search-result]").first();
  const hitTarget = Number(
    (await first.locator(".tabular-nums").textContent())?.replace("%", ""),
  );
  await first.click();
  await page.waitForTimeout(800);
  const hitPercent = await currentPercent(page);
  check(
    Math.abs(hitPercent - hitTarget) <= 2,
    `search jump lands at the hit's progress (${hitTarget}% → ${hitPercent}%)`,
  );

  await context.close();
}

async function pdfFlow(browser: import("playwright-core").Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.setInputFiles('input[accept*="pdf"]', PDF_PATH);
  await openFreshTile(page, "[data-pdf-page] canvas");
  await page.waitForTimeout(2_000); // the outline pass lands after the doc

  // Theme: dark applies a CSS filter to the page canvas (light has none).
  await setDarkTheme(page);
  const filter = await page.evaluate(() => {
    const canvas = document.querySelector("[data-pdf-page] canvas");
    return canvas ? getComputedStyle(canvas).filter : "";
  });
  check(
    filter !== "" && filter !== "none",
    `dark theme filters the pdf canvas (${filter})`,
  );

  // Outline: the TOC button shows only when the document has bookmarks.
  const tocButtons = await page.locator('button[aria-label="Contents"]').count();
  if (tocButtons === 0) {
    check(true, "pdf without an outline hides the toc button");
  } else {
    await clickChromeButton(page, 'button[aria-label="Contents"]');
    await page.waitForSelector('[data-reader-panel="toc"]', { timeout: 5_000 });
    const entries = page.locator("[data-toc-entry]");
    const entryCount = await entries.count();
    check(entryCount >= 1, `pdf outline listed (${entryCount} entries)`);
    const pick = entries.nth(Math.min(2, entryCount - 1));
    const tocTarget = Number(await pick.locator(".tabular-nums").textContent());
    await pick.click();
    await page.waitForTimeout(1_000);
    check(
      (await currentPage(page)) === spreadFirstOf(tocTarget),
      `pdf outline jump lands on the entry's spread (${tocTarget})`,
    );
  }

  // Search: "the" must hit early and often in an English book.
  await clickChromeButton(page, 'button[aria-label="Search in book"]');
  await page.waitForSelector('[data-reader-panel="search"]', { timeout: 5_000 });
  await page.fill('[data-reader-panel="search"] input', "the");
  await page.waitForSelector("[data-search-result]", { timeout: 30_000 });
  const resultCount = await page.locator("[data-search-result]").count();
  check(resultCount >= 1, `pdf search finds hits (${resultCount})`);
  const first = page.locator("[data-search-result]").first();
  const hitTarget = Number(await first.locator(".tabular-nums").textContent());
  await first.click();
  await page.waitForTimeout(1_000);
  check(
    (await currentPage(page)) === spreadFirstOf(hitTarget),
    `pdf search jump lands on the hit's spread (${hitTarget})`,
  );

  await context.close();
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  await epubFlow(browser);
  await pdfFlow(browser);
  await browser.close();
  if (problems.length) {
    console.log(`\nreader-panel-smoke: ${problems.length} problem(s)`);
    problems.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  console.log("\nreader-panel-smoke: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
