// Shelf-section collapse checker: drives the real shelf UI in headless Chrome.
// Flow: import two books → group header collapses the section into a cover
// stack (tiles leave the DOM) → collapse persists across reload → clicking
// the stack expands → the caret collapses/expands too. With YUKI_TEST_MANGA_DIR
// set, a manga volume joins the same language group: the mixed group
// (小説 + 漫画 h3 subsections) folds as a whole, and the manga subsection
// folds on its own, leaving the novels grid in place → cleanup.
// Usage: pnpm tsx tests/shelf-collapse-smoke.ts [title substring] [second book]

import { mkdirSync, readdirSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { ensureServer, launchBrowser } from "./browser-harness.ts";
import { join } from "node:path";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const FILTER = process.argv[2] ?? requireEnv("YUKI_TEST_EPUB_FILTER");
const FILTER2 = process.argv[3] ?? requireEnv("YUKI_TEST_EPUB_FILTER2");
const MANGA_DIR = process.env.YUKI_TEST_MANGA_DIR; // optional: mixed-group checks
const BASE = "http://localhost:1420";
const SHOT_DIR = "artifacts/local/browser/screenshots";

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

// All files of a folder-drop volume: the scans plus the sidecar next to them.
function volumeFiles(
  mangaDir: string,
  relDir: string,
  relMokuro: string,
): string[] {
  const dir = join(mangaDir, relDir);
  const images = readdirSync(dir)
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .map((name) => join(dir, name));
  return [...images, join(mangaDir, relMokuro)];
}

async function main(): Promise<void> {
  const files = readdirSync(NOVELS_DIR).filter((f) =>
    f.toLowerCase().endsWith(".epub"),
  );
  const file1 = files.find((f) => f.includes(FILTER));
  const file2 = files.find((f) => f.includes(FILTER2));
  if (!file1 || !file2) {
    throw new Error(`need epubs matching "${FILTER}" and "${FILTER2}" in ${NOVELS_DIR}`);
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  await ensureServer();
  const { browser, page } = await launchBrowser();
  await page.goto(BASE);

  // Import two books.
  await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, file1));
  await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
  await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, file2));
  await page.waitForFunction(
    () => document.querySelectorAll("[data-book-id]").length === 2,
    { timeout: 60_000 },
  );
  check(true, "two books on the shelf");

  const header = page.locator("[data-shelf-header]").first();
  check((await page.locator("[data-shelf-header]").count()) >= 1, "group header is shown");
  check(
    (await header.getAttribute("aria-expanded")) === "true",
    "section starts expanded",
  );

  // Collapse via the header caret.
  await header.click();
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${SHOT_DIR}/shelf-collapse-mid.png` });
  await page.waitForTimeout(500);
  check((await page.locator("[data-book-id]").count()) === 0, "collapse removes the tiles");
  check((await page.locator("[data-shelf-stack]").count()) === 1, "cover stack is shown");
  check(
    (await header.getAttribute("aria-expanded")) === "false",
    "caret reports collapsed",
  );
  await page.hover("[data-shelf-stack]");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOT_DIR}/shelf-stack-hover.png` });
  await page.mouse.move(640, 400);
  await page.screenshot({ path: `${SHOT_DIR}/shelf-collapsed.png` });

  // Persistence across reload.
  await page.reload();
  await page.waitForTimeout(1500);
  check((await page.locator("[data-shelf-stack]").count()) === 1, "collapse persists after reload");
  check((await page.locator("[data-book-id]").count()) === 0, "tiles stay folded after reload");

  // Expand via the stack.
  await page.click("[data-shelf-stack]");
  await page.waitForTimeout(500);
  check((await page.locator("[data-book-id]").count()) === 2, "stack click brings the tiles back");
  check((await page.locator("[data-shelf-stack]").count()) === 0, "stack is gone once expanded");

  // Collapse + expand via the caret only.
  await header.click();
  await page.waitForTimeout(500);
  check((await page.locator("[data-shelf-stack]").count()) === 1, "caret collapses again");
  await header.click();
  await page.waitForTimeout(500);
  check((await page.locator("[data-book-id]").count()) === 2, "caret expands again");

  // --- mixed group: a manga volume joins the two novels -----------------------
  // The 小説/漫画 subsections appear only when both kinds share a language
  // group, so these checks need YUKI_TEST_MANGA_DIR.
  if (MANGA_DIR) {
    await page.setInputFiles(
      'input[accept*=".mokuro"]',
      volumeFiles(MANGA_DIR, "Oshinoko_2/Oshinoko_02", "Oshinoko_2/Oshinoko_02.mokuro"),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("[data-book-id]").length === 3,
      { timeout: 120_000 },
    );
    check(true, "manga series joins the novels' group");
    check(
      (await page.locator("[data-shelf-header]").count()) === 3,
      "group header + two subsection headers",
    );

    // The whole mixed group folds into one stack, novels and manga alike.
    const groupHeader = page.locator("section h2 [data-shelf-header]").first();
    await groupHeader.click();
    await page.waitForTimeout(500);
    check(
      (await page.locator("[data-book-id]").count()) === 0,
      "mixed group fold removes every tile",
    );
    check(
      (await page.locator("[data-shelf-stack]").count()) === 1,
      "one stack for the mixed group",
    );
    await page.click("[data-shelf-stack]");
    await page.waitForTimeout(500);
    check(
      (await page.locator("[data-book-id]").count()) === 3,
      "unfold brings every tile back",
    );

    // The manga h3 subsection folds on its own — the novels grid stays.
    const mangaHeader = page.locator("h3 [data-shelf-header]").last();
    await mangaHeader.click();
    await page.waitForTimeout(500);
    check(
      (await page.locator("[data-book-id]").count()) === 2,
      "manga subsection folds on its own, novels stay",
    );
    check(
      (await page.locator("[data-shelf-stack]").count()) === 1,
      "subsection stack next to the novels grid",
    );
    await mangaHeader.click();
    await page.waitForTimeout(500);
    check(
      (await page.locator("[data-book-id]").count()) === 3,
      "subsection expands again",
    );
  } else {
    console.log("  · YUKI_TEST_MANGA_DIR unset — skipping the mixed-group checks");
  }

  // Cleanup: delete every tile via the context menu.
  const tiles = await page.locator("[data-book-id]").count();
  for (let i = 0; i < tiles; i += 1) {
    await page.click("[data-book-id]", { button: "right" });
    await page.click("[role=menu] >> text=Delete");
    await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
    await page.click('[role=alertdialog] button:text-is("Delete")');
    await page.waitForTimeout(500);
  }
  check((await page.locator("[data-book-id]").count()) === 0, "cleanup delete works");

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nSHELF COLLAPSE CHECK: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nSHELF COLLAPSE CHECK: PASS");
}

await main();
