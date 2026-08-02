// Group-fold visual probe: one novel + one manga volume in the Japanese
// section, then collapse/expand the whole language group and capture
// mid-animation frames. Verifies the stack order matches the DOM order
// (novels first, manga second) — the manga cover must fly from the manga
// tile, not across the section.
// Usage: pnpm tsx tests/group-stack-probe.ts

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium } from "playwright-core";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const MANGA_DIR = requireEnv("YUKI_TEST_MANGA_DIR");
const FILTER = process.argv[2] ?? requireEnv("YUKI_TEST_EPUB_FILTER");
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

function volumeFiles(relDir: string, relMokuro: string): string[] {
  const dir = join(MANGA_DIR, relDir);
  const images = readdirSync(dir)
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .map((name) => join(dir, name));
  return [...images, join(MANGA_DIR, relMokuro)];
}

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

async function main(): Promise<void> {
  const novel = readdirSync(NOVELS_DIR).find(
    (f) => f.toLowerCase().endsWith(".epub") && f.includes(FILTER),
  );
  if (!novel) throw new Error(`no epub matching "${FILTER}"`);
  mkdirSync(SHOT_DIR, { recursive: true });

  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(BASE);

  // Import one novel and one manga volume → 日本語: 小説 + 漫画.
  await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, novel));
  await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
  await page.setInputFiles(
    'input[accept*=".mokuro"]',
    volumeFiles("Oshinoko_2/Oshinoko_02", "Oshinoko_2/Oshinoko_02.mokuro"),
  );
  await page.waitForFunction(
    () => document.querySelectorAll("[data-book-id]").length === 2,
    { timeout: 120_000 },
  );
  check(true, "novel + manga series on the shelf");
  check(
    (await page.locator("[data-shelf-header]").count()) === 3,
    "group header + two subsection headers",
  );

  const groupHeader = page.locator("section h2 [data-shelf-header]").first();

  // Collapse the whole language group — capture the flight.
  await groupHeader.click();
  for (const [i, ms] of [60, 120, 220].entries()) {
    await page.waitForTimeout(i === 0 ? ms : 80);
    await page.screenshot({ path: `${SHOT_DIR}/group-fold-${i + 1}.png` });
  }
  await page.waitForTimeout(300);
  check((await page.locator("[data-book-id]").count()) === 0, "group fold removes every tile");
  check((await page.locator("[data-shelf-stack]").count()) === 1, "one group stack");
  await page.screenshot({ path: `${SHOT_DIR}/group-fold-final.png` });

  // Expand — capture the return.
  await page.click("[data-shelf-stack]");
  for (const [i, ms] of [60, 140, 240].entries()) {
    await page.waitForTimeout(i === 0 ? ms : 80);
    await page.screenshot({ path: `${SHOT_DIR}/group-unfold-${i + 1}.png` });
  }
  await page.waitForTimeout(300);
  check((await page.locator("[data-book-id]").count()) === 2, "unfold brings every tile back");

  // Collapse only the manga subsection.
  const mangaHeader = page.locator("h3 [data-shelf-header]").last();
  await mangaHeader.click();
  await page.waitForTimeout(500);
  check(
    (await page.locator("[data-book-id]").count()) === 1,
    "manga sub folds on its own, novel stays",
  );
  check(
    (await page.locator("[data-shelf-stack]").count()) === 1,
    "manga sub stack next to the novels grid",
  );
  await page.screenshot({ path: `${SHOT_DIR}/sub-fold-manga.png` });

  // Cleanup: expand, delete both tiles.
  await mangaHeader.click();
  await page.waitForTimeout(500);
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
    console.log(`\nGROUP STACK PROBE: FAIL (${problems.length} problems)`);
    process.exit(1);
  }
  console.log("\nGROUP STACK PROBE: PASS");
}

await main();
