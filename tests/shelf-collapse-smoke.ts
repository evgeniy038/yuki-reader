// Shelf-section collapse checker: drives the real shelf UI in headless Chrome.
// Flow: import two books → group header collapses the section into a cover
// stack (tiles leave the DOM) → collapse persists across reload → clicking
// the stack expands → the caret collapses/expands too → cleanup.
// Usage: pnpm tsx tests/shelf-collapse-smoke.ts [title substring] [second book]

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium } from "playwright-core";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const FILTER = process.argv[2] ?? requireEnv("YUKI_TEST_EPUB_FILTER");
const FILTER2 = process.argv[3] ?? requireEnv("YUKI_TEST_EPUB_FILTER2");
const BASE = "http://localhost:1420";
const SHOT_DIR = "artifacts/local/browser/screenshots";

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
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
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

  // Cleanup: delete both books via the context menu.
  for (let i = 0; i < 2; i += 1) {
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
