// Library-management checker: drives the real shelf UI in headless Chrome.
// Flow: import (stays on the shelf) → open tile → exit reader → re-import
// (duplicate rejected, card flashes) → header add-book action → context
// menu: rename / cover / delete (alert-dialog confirm) → reload (deletion
// persists) → re-import lands on the shelf → two books in one batch:
// recency sort, reading state on the tile, details dialog, library view:
// header count, sort select (+ persistence across reload).
// Usage: pnpm tsx tests/library-smoke.ts [title substring] [second book] — or YUKI_TEST_EPUB_FILTER / YUKI_TEST_EPUB_FILTER2

import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium } from "playwright-core";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const FILTER = process.argv[2] ?? requireEnv("YUKI_TEST_EPUB_FILTER");
const FILTER2 = process.argv[3] ?? requireEnv("YUKI_TEST_EPUB_FILTER2");
const BASE = "http://localhost:1420";
const NEW_TITLE = "Переименованная книга テスト";

// 1×1 red PNG for the cover-change check.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

async function deleteViaMenu(page: import("playwright-core").Page): Promise<void> {
  await page.click("[data-book-id]", { button: "right" });
  await page.click("[role=menu] >> text=Delete");
  await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
  await page.click('[role=alertdialog] button:text-is("Delete")');
  await page.waitForTimeout(500);
}

async function main(): Promise<void> {
  const file = readdirSync(NOVELS_DIR).find(
    (f) => f.toLowerCase().endsWith(".epub") && f.includes(FILTER),
  );
  if (!file) throw new Error(`no epub matching "${FILTER}" in ${NOVELS_DIR}`);
  const epubPath = join(NOVELS_DIR, file);
  const pngPath = "/tmp/yuki-cover-probe.png";
  writeFileSync(pngPath, Buffer.from(PNG_B64, "base64"));

  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(BASE);

  // 1. Import → the book lands on the shelf (no auto-open; batch-friendly),
  // the tile opens the reader.
  await page.setInputFiles('input[accept*="epub"]', epubPath);
  await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
  check((await page.locator(".book-content").count()) === 0, "import stays on the shelf");
  await page.locator("[data-book-id]").first().click();
  await page.waitForSelector(".book-content", { timeout: 30_000 });
  check(true, "tile click opens the reader");
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  check((await page.locator("[data-book-id]").count()) === 1, "one card on the shelf");
  const cardText = (await page.locator("[data-book-id]").textContent()) ?? "";
  check(cardText.includes(FILTER), "title is shown under the cover");

  // 2. Re-import the same file → duplicate rejected, no second card, no reader.
  await page.setInputFiles('input[accept*="epub"]', epubPath);
  await page.waitForSelector("text=is already in the library", { timeout: 60_000 });
  check(true, "duplicate import shows the notice");
  await page.waitForTimeout(500);
  check((await page.locator("[data-book-id]").count()) === 1, "still one card after duplicate");
  check((await page.locator(".book-content").count()) === 0, "duplicate does not open the reader");

  // 3. Library header offers the primary import action.
  check(
    (await page.locator('button:text-is("Add book")').count()) === 1,
    "library header offers the add-book action",
  );

  // 4. Context menu → rename.
  await page.click("[data-book-id]", { button: "right" });
  await page.waitForSelector("[role=menu]", { timeout: 5_000 });
  check(true, "right-click opens the context menu");
  await page.click("[role=menu] >> text=Rename");
  await page.waitForSelector("[role=dialog] input", { timeout: 5_000 });
  await page.fill("[role=dialog] input", NEW_TITLE);
  await page.click('[role=dialog] button:text-is("Save")');
  await page.waitForTimeout(300);
  const renamedText = (await page.locator("[data-book-id]").textContent()) ?? "";
  check(renamedText.includes(NEW_TITLE), "context-menu rename updates the card");

  // 5. Context menu → cover.
  await page.click("[data-book-id]", { button: "right" });
  await page.click("[role=menu] >> text=Change cover");
  await page.setInputFiles('input[accept="image/*"]', pngPath);
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-book-id] img")
        ?.getAttribute("src")
        ?.startsWith("data:image/") ?? false,
    { timeout: 5_000 },
  );
  check(true, "context-menu cover replaces the image");

  // 6. Context menu → delete (alert-dialog confirm).
  await page.click("[data-book-id]", { button: "right" });
  await page.click("[role=menu] >> text=Delete");
  await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
  check(true, "context-menu delete asks for confirmation");
  await page.click('[role=alertdialog] button:text-is("Delete")');
  await page.waitForTimeout(500);
  check((await page.locator("[data-book-id]").count()) === 0, "card deleted via context menu");

  // 7. Reload → deletion persists (IndexedDB).
  await page.reload();
  await page.waitForTimeout(1500);
  check((await page.locator("[data-book-id]").count()) === 0, "deletion persists after reload");

  // 8. Re-import → the shelf shows the fresh import (default sort is recency).
  await page.setInputFiles('input[accept*="epub"]', epubPath);
  await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
  check(
    ((await page.locator("[data-book-id]").textContent()) ?? "").includes(
      FILTER,
    ),
    "shelf lists the fresh import",
  );

  // 9. Cleanup: remove the test book.
  await deleteViaMenu(page);
  check((await page.locator("[data-book-id]").count()) === 0, "cleanup delete works");

  // 10. Two books → recency sort, reading state, details, sort select.
  const file2 = readdirSync(NOVELS_DIR).find(
    (f) => f.toLowerCase().endsWith(".epub") && f.includes(FILTER2),
  );
  if (!file2) throw new Error(`no epub matching "${FILTER2}" in ${NOVELS_DIR}`);
  const cardTexts = async () => page.locator("[data-book-id]").allTextContents();
  const idxOf = async (needle: string) =>
    (await cardTexts()).findIndex((t) => t.includes(needle));

  await page.setInputFiles('input[accept*="epub"]', epubPath);
  await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
  await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, file2));
  await page.waitForFunction(
    () => document.querySelectorAll("[data-book-id]").length === 2,
    { timeout: 60_000 },
  );
  check((await idxOf(FILTER2)) === 0 && (await idxOf(FILTER)) === 1, "recent: batch import leads with the freshest");

  // Open the older book → it becomes the most recent; a page turn → percent.
  await page.locator("[data-book-id]", { hasText: FILTER }).click();
  await page.waitForSelector(".book-content", { timeout: 10_000 });
  await page.waitForTimeout(1500); // let the paginator measure before turning
  // Front matter has ~0 countable chars — turn deep enough for progress > 0.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(200);
  }
  // The bookmark (and with it the tile's percent) commits after a 3s dwell.
  await page.waitForTimeout(3_500);
  await page.mouse.move(720, 10); // wake the auto-hidden chrome (top edge only)
  await page.waitForTimeout(500);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForTimeout(800);
  check((await idxOf(FILTER)) === 0, "recent: opened book leads the shelf");
  const aText = (await cardTexts())[await idxOf(FILTER)] ?? "";
  check(/%/.test(aText), "reading percent shown on the tile");

  // Details dialog.
  await page.locator("[data-book-id]", { hasText: FILTER }).click({ button: "right" });
  await page.click("[role=menu] >> text=Details");
  await page.waitForSelector("[role=dialog]", { timeout: 5_000 });
  const detailsText = (await page.locator("[role=dialog]").textContent()) ?? "";
  check(
    detailsText.includes("Characters") && detailsText.includes(FILTER),
    "details dialog shows facts about the book",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Switch to the library view: header count, sort select, group headers.
  await page.click('button[data-view="library"]');
  await page.waitForTimeout(400);
  check(
    ((await page.locator("h1").textContent()) ?? "").includes("Library · 2"),
    "library header shows the book count",
  );

  // Sort select → Title; order follows localeCompare of the titles.
  await page.click('button[aria-label="shelf sort"]');
  await page.waitForSelector("[role=listbox]", { timeout: 5_000 });
  await page.click("[role=listbox] >> text=Title");
  await page.waitForTimeout(400);
  const titles = await page
    .locator("[data-book-id] > p:nth-of-type(1)")
    .allTextContents();
  const expected = [...titles].sort((a, b) => a.localeCompare(b, "ja"));
  check(
    JSON.stringify(titles) === JSON.stringify(expected),
    "sort select orders by title",
  );

  // Sort persists across reload (back on the library view).
  await page.reload();
  await page.waitForTimeout(1500);
  await page.click('button[data-view="library"]');
  await page.waitForTimeout(400);
  const titlesAfter = await page
    .locator("[data-book-id] > p:nth-of-type(1)")
    .allTextContents();
  check(
    JSON.stringify(titlesAfter) === JSON.stringify(expected),
    "sort persists across reload",
  );

  // Group headers are always shown (they carry the collapse caret).
  check((await page.locator("section h2").count()) === 1, "one group header for one language");

  // Cleanup both books.
  await deleteViaMenu(page);
  await deleteViaMenu(page);
  check((await page.locator("[data-book-id]").count()) === 0, "both books deleted");

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nLIBRARY CHECK: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nLIBRARY CHECK: PASS");
}

await main();
