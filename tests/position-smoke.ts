// Position-restore checker for the paginated reader (character-anchored
// reading position). Drives the real app in headless system Chrome:
//   1. page forward several times onto a text page; the explored count at
//      the page top IS the character anchor (glyph-precise)
//   2. resize the window — the anchor must not jump forward, and it must
//      stay inside the landed page: explored(page) ≤ anchor < explored(next)
//   3. resize back — the same page index and explored count must return
// Also asserts the indicator shows "explored / total pct%" with total > 0.
// Runs against the ?demo books (vertical + horizontal), then every epub in
// the novels folder. Dev server is spawned if absent.
// Usage: pnpm tsx tests/position-smoke.ts [novelsDir] [substring filter]

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const NOVELS_DIR = process.argv[2] ?? requireEnv("YUKI_TEST_EPUB_DIR");
const FILTER = process.argv[3] ?? "";
const BASE = "http://localhost:1420";
const FLIPS = 8;
const VIEW_A = { width: 1280, height: 800 };
const VIEW_B = { width: 1010, height: 730 };

interface Snapshot {
  page: number;
  pages: number;
  explored: number;
  total: number;
  error?: string;
}

const takeSnapshot = (): Snapshot => {
  const article = document.querySelector(".book-content");
  const indicatorEl = document.querySelector("[data-page-indicator]");
  const empty = { page: -1, pages: 0, explored: 0, total: 0 };
  if (!article || !indicatorEl) return { ...empty, error: "no reader" };
  const nums = indicatorEl.textContent?.match(/(\d+)\s*\/\s*(\d+)/);
  return {
    page: Number(indicatorEl.getAttribute("data-page")),
    pages: Number(indicatorEl.getAttribute("data-pages")),
    explored: nums ? Number(nums[1]) : -1,
    total: nums ? Number(nums[2]) : -1,
  };
};

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

async function waitForReader(page: Page): Promise<void> {
  await page.waitForSelector(".book-content > *", { state: "attached", timeout: 60_000 });
  await page.waitForFunction(
    () =>
      Number(
        document.querySelector("[data-page-indicator]")?.getAttribute("data-pages"),
      ) >= 1,
    { timeout: 60_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.querySelectorAll("img")).map((img) =>
        img.complete
          ? null
          : new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            }),
      ),
    ),
  );
}

// Wait until the re-measure after a resize has landed: the indicator's page
// count must agree with the live column geometry.
async function waitForSettled(page: Page): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const settled = await page.evaluate(() => {
      const article = document.querySelector(".book-content");
      const contentEl = article?.parentElement;
      const scrollEl = contentEl?.parentElement;
      if (!article || !contentEl || !scrollEl) return false;
      const outerEl = scrollEl.parentElement;
      if (!outerEl) return false;
      const vertical = getComputedStyle(contentEl).writingMode.includes("vertical");
      const viewport = vertical ? scrollEl.clientHeight : scrollEl.clientWidth;
      // Guard against pre-measure staleness: the scroll box must already have
      // been resized to the CURRENT outer box (vertical page box = outer − 2·40).
      const expected = vertical ? outerEl.clientHeight - 80 : outerEl.clientWidth;
      if (Math.abs(viewport - expected) > 1) return false;
      const scrollSize = vertical ? scrollEl.scrollHeight : scrollEl.scrollWidth;
      if (!viewport || !scrollSize) return false;
      const pages = Math.max(1, Math.round((scrollSize + 40) / (viewport + 40)));
      const indicated = Number(
        document.querySelector("[data-page-indicator]")?.getAttribute("data-pages"),
      );
      return indicated === pages;
    });
    if (settled) return;
    await page.waitForTimeout(100);
  }
}

async function checkBook(page: Page, name: string, fwd: string): Promise<string[]> {
  const problems: string[] = [];
  const back = fwd === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
  await waitForReader(page);
  await waitForSettled(page);

  for (let i = 0; i < FLIPS; i += 1) {
    await page.keyboard.press(fwd);
    await page.waitForTimeout(80);
  }
  // Land on a TEXT page: image-only pages don't advance the explored count,
  // so probe the next page and keep flipping while it stays put (≤3 extra).
  for (let tries = 0; tries < 3; tries += 1) {
    const before = (await page.evaluate(takeSnapshot)) as Snapshot;
    await page.keyboard.press(fwd);
    await page.waitForTimeout(80);
    const after = (await page.evaluate(takeSnapshot)) as Snapshot;
    if (after.explored > before.explored) {
      await page.keyboard.press(back);
      await page.waitForTimeout(80);
      break;
    }
  }
  const a = (await page.evaluate(takeSnapshot)) as Snapshot;
  if (a.error) return [`${name}: ${a.error}`];
  if (a.total <= 0) problems.push(`${name}: indicator total is ${a.total}, expected > 0`);

  await page.setViewportSize(VIEW_B);
  await waitForSettled(page);
  const b = (await page.evaluate(takeSnapshot)) as Snapshot;
  if (b.explored > a.explored)
    problems.push(
      `${name}: resize jumped forward: explored ${a.explored} → ${b.explored} (total ${a.total})`,
    );

  await page.setViewportSize(VIEW_A);
  await waitForSettled(page);
  const c = (await page.evaluate(takeSnapshot)) as Snapshot;
  if (c.page !== a.page)
    problems.push(`${name}: round-trip page drifted: ${a.page} → ${c.page}`);
  if (c.explored !== a.explored)
    problems.push(
      `${name}: round-trip explored drifted: ${a.explored} → ${c.explored} (total ${a.total})`,
    );

  // Containment: after a resize the anchor char must sit on the landed page —
  // explored(page) ≤ anchor < explored(next page). Probing the next page
  // disturbs the anchor, so it runs last. At the book's end (no next page)
  // only the left side is asserted.
  await page.setViewportSize(VIEW_B);
  await waitForSettled(page);
  const b2 = (await page.evaluate(takeSnapshot)) as Snapshot;
  await page.keyboard.press(fwd);
  await page.waitForTimeout(80);
  const next = (await page.evaluate(takeSnapshot)) as Snapshot;
  if (next.explored > b2.explored) {
    if (!(b2.explored <= a.explored && a.explored < next.explored))
      problems.push(
        `${name}: resize lost the anchor char — explored ${a.explored} not within page ${b2.page} [${b2.explored}, ${next.explored})`,
      );
  } else if (b2.explored > a.explored) {
    problems.push(
      `${name}: resize lost the anchor char — explored ${a.explored} before page ${b2.page} start ${b2.explored}`,
    );
  }
  return problems;
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const allProblems: string[] = [];

  for (const demo of [
    { url: `${BASE}/?demo`, name: "demo-vertical", fwd: "ArrowLeft" },
    { url: `${BASE}/?demo=h`, name: "demo-horizontal", fwd: "ArrowRight" },
  ]) {
    const context = await browser.newContext({ viewport: VIEW_A });
    const page = await context.newPage();
    await page.goto(demo.url);
    allProblems.push(...(await checkBook(page, demo.name, demo.fwd)));
    await context.close();
    console.log(`checked ${demo.name}`);
  }

  const epubs = readdirSync(NOVELS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".epub"))
    .filter((f) => (FILTER === "" ? true : f.includes(FILTER)))
    .sort();
  console.log(`checking ${epubs.length} epubs from ${NOVELS_DIR}`);

  for (const file of epubs) {
    const context = await browser.newContext({ viewport: VIEW_A });
    const page = await context.newPage();
    const name = file.length > 40 ? `${file.slice(0, 37)}…` : file;
    try {
      await page.goto(BASE);
      await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, file));
      allProblems.push(...(await checkBook(page, name, "ArrowLeft")));
      console.log(`checked ${name}`);
    } catch (err) {
      allProblems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`FAILED  ${name}`);
    }
    await context.close();
  }

  await browser.close();
  if (allProblems.length > 0) {
    console.log(`\nPOSITION CHECK: FAIL (${allProblems.length} problems)`);
    for (const p of allProblems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log("\nPOSITION CHECK: PASS");
}

await main();
