// Drag regression checker: a press-and-move on the manga stage must never
// darken the page with a selection or lift a native drag ghost — the stage is
// select-none, page images are draggable=false, and any dragstart that still
// fires is canceled at the container. Open OCR boxes keep their text
// selectable. Uses one sidecar volume (import is instant, no OCR wait).
// Fixture root: YUKI_TEST_MANGA_DIR (see tests/README.md).
// Usage: pnpm tsx tests/manga-drag-smoke.ts

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

function volumeFiles(relDir: string, relMokuro: string): string[] {
  const dir = join(MANGA_DIR, relDir);
  const images = readdirSync(dir)
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .map((name) => join(dir, name));
  return [...images, join(MANGA_DIR, relMokuro)];
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

async function deleteFirstTile(page: Page): Promise<void> {
  await page.locator("[data-book-id]").first().click({ button: "right" });
  await page.click("[role=menu] >> text=Delete");
  await page.waitForSelector("[role=alertdialog]", { timeout: 5_000 });
  await page.click('[role=alertdialog] button:text-is("Delete")');
  await page.waitForTimeout(500);
}

// A press-drag across the stage, then the two invariants: nothing got
// selected and no drag ghost slipped through uncanceled.
async function dragAcross(page: Page, label: string): Promise<void> {
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(1100, 650, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const outcome = await page.evaluate(() => ({
    selection: window.getSelection()?.toString() ?? "",
    drags: (window as unknown as { __drags: boolean[] }).__drags,
  }));
  check(outcome.selection === "", `${label}: no selection after the drag`);
  check(
    outcome.drags.every((canceled) => canceled),
    `${label}: every dragstart canceled (${outcome.drags.length} fired)`,
  );
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
  while ((await page.locator("[data-book-id]").count()) > 0) {
    await deleteFirstTile(page);
  }

  await page.setInputFiles(
    'input[accept*=".mokuro"]',
    volumeFiles("Oshinoko_2/Oshinoko_02", "Oshinoko_2/Oshinoko_02.mokuro"),
  );
  await page.waitForSelector("[data-book-id]", { timeout: 120_000 });
  await page.waitForTimeout(500);
  await page.locator("[data-book-id]").first().click();
  await page.waitForTimeout(500);
  await page.locator("[data-book-id]").first().click();
  await page.waitForSelector("[data-manga-page] img", { timeout: 60_000 });
  await settleOnPage(page, 1);

  const stageSelect = await page.evaluate(
    () => getComputedStyle(document.querySelector("[data-manga-page]")!).userSelect,
  );
  check(stageSelect === "none", "stage: user-select is none");
  const imgDraggable = await page.evaluate(
    () => document.querySelector("[data-manga-page] img")!.getAttribute("draggable"),
  );
  check(imgDraggable === "false", "stage: page image is not draggable");

  // Record dragstarts at the document — by bubble time the container handler
  // must already have canceled each one.
  await page.evaluate(() => {
    (window as unknown as { __drags: boolean[] }).__drags = [];
    document.addEventListener("dragstart", (event) => {
      (window as unknown as { __drags: boolean[] }).__drags.push(event.defaultPrevented);
    });
  });

  await dragAcross(page, "single page");

  // An open OCR box keeps its text selectable (userSelect flips to text).
  await page.locator("[data-ocr-block]").first().click();
  await page.waitForTimeout(200);
  const openSelect = await page
    .locator("[data-ocr-block] div")
    .first()
    .evaluate((el) => getComputedStyle(el).userSelect);
  check(openSelect === "text", "ocr: a pinned box stays selectable");

  // Spread: the same gesture across both pages and the gutter.
  await page.keyboard.press("ArrowLeft");
  await settleOnPage(page, 2);
  check(
    (await page.locator("[data-manga-page] img").count()) === 2,
    "spread: two pages on screen",
  );
  await dragAcross(page, "spread");

  // Paging is not broken by select-none: the edge click still flips forward.
  await page.mouse.click(10, 400);
  await settleOnPage(page, 4);
  console.log("  ✓ paging: edge click still flips the page");

  await browser.close();
  if (problems.length > 0) {
    console.log(`\nDRAG CHECK: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nDRAG CHECK: PASS");
}

await main();
