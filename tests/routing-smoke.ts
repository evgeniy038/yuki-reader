// Routing checker: every screen is a real URL that survives a refresh.
// Flow: direct URLs (/stats, /settings, unknown → home) → import opens
// /read/:id → reload keeps the reader → exit returns to / → history.back
// reopens the book → reload on /stats stays on stats.
// Usage: pnpm tsx tests/routing-smoke.ts [title substring, or YUKI_TEST_EPUB_FILTER]

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium } from "playwright-core";

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

async function main(): Promise<void> {
  const file = readdirSync(NOVELS_DIR).find(
    (f) => f.toLowerCase().endsWith(".epub") && f.includes(FILTER),
  );
  if (!file) throw new Error(`no epub matching "${FILTER}" in ${NOVELS_DIR}`);
  const epubPath = join(NOVELS_DIR, file);

  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // 1. Direct deep links render their page.
  await page.goto(`${BASE}/#/stats`);
  await page.waitForSelector("text=Statistics", { timeout: 15_000 });
  check(true, "/#/stats renders the stats page directly");
  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector("text=Reading", { timeout: 15_000 });
  check(true, "/#/settings renders the settings page directly");

  // 2. Unknown path falls back to the library.
  await page.goto(`${BASE}/#/read/definitely-not-a-book`);
  await page.waitForSelector("text=Library", { timeout: 15_000 });
  check(
    page.url().endsWith("/") || page.url().endsWith("#/"),
    "unknown /read/:id redirects home",
  );

  // 3. Import → the reader opens at its own URL.
  await page.setInputFiles('input[accept*="epub"]', epubPath);
  await page.waitForSelector(".book-content", { timeout: 60_000 });
  check(page.url().includes("#/read/"), "import opens the reader at /read/:id");
  const readUrl = page.url();

  // 4. Refresh while reading: same URL, reader restored (through the loader).
  await page.reload();
  await page.waitForSelector(".book-content", { timeout: 60_000 });
  check(page.url() === readUrl, "refresh keeps the reader URL");
  check(true, "reader comes back after refresh");

  // 5. Exit to the shelf → home URL; history back → the book again.
  await page.mouse.move(720, 10);
  await page.waitForTimeout(400);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  check(
    page.url().endsWith("#/") || page.url().endsWith("/"),
    "exit returns to the shelf URL",
  );
  await page.goBack();
  await page.waitForSelector(".book-content", { timeout: 30_000 });
  check(page.url() === readUrl, "history.back reopens the book at its URL");

  // 6. Refresh on /stats stays on /stats.
  await page.mouse.move(720, 10);
  await page.waitForTimeout(400);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  await page.click('button[data-view="stats"]');
  await page.waitForSelector("text=Statistics", { timeout: 10_000 });
  await page.reload();
  await page.waitForSelector("text=Statistics", { timeout: 15_000 });
  check(page.url().includes("#/stats"), "refresh stays on the stats page");

  // 7. The nav pill still tracks the URL (active marker follows location).
  const ariaCurrent = await page
    .locator('button[data-view="stats"]')
    .getAttribute("aria-current");
  check(ariaCurrent === "page", "nav pill marks the active page from the URL");

  await browser.close();
  if (problems.length) {
    console.log(`\nrouting-smoke: ${problems.length} problem(s)`);
    problems.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  console.log("\nrouting-smoke: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
