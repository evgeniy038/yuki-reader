// Statistics checker: drives the real reading session in headless Chrome.
// Flow: import → turn 3 pages (real pipeline: chars + active time flush) →
// exit reader → stats view shows today's numbers → seed 4 adjacent past days
// straight into IndexedDB → streak = 5, heatmap has 5 colored cells → goal
// stepper changes the value and survives a reload.
// Usage: pnpm tsx tests/stats-smoke.ts [title substring, or YUKI_TEST_EPUB_FILTER]

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

async function openStats(page: import("playwright-core").Page): Promise<void> {
  await page.click('button[data-view="stats"]');
  await page.waitForSelector("text=Characters today", { timeout: 10_000 });
}

async function rowValue(
  page: import("playwright-core").Page,
  label: string,
): Promise<string> {
  const row = page.locator(`span:text-is("${label}")`).locator("..");
  return (await row.textContent()) ?? "";
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
  await page.goto(BASE);

  // 1. Real reading session: import → reader opens → turn 3 pages, dwelling
  // 3.5s on each — a page's chars count only after the 3s dwell commits it.
  await page.setInputFiles('input[accept*="epub"]', epubPath);
  await page.waitForSelector(".book-content", { timeout: 60_000 });
  check(true, "import opens the reader");
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("ArrowLeft"); // vertical: ArrowLeft = next page
    await page.waitForTimeout(3_500);
  }
  // Two 5s heartbeats ticked during the dwells: the session passed the 10s
  // warmup, so pending chars + active time have already flushed.
  await page.waitForTimeout(1_000);
  // The reader chrome auto-hides when idle and only reveals near the top
  // edge (clientY < 40) — wake it with a mouse move there.
  await page.mouse.move(720, 10);
  await page.waitForTimeout(300);
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  check(true, "exit back to the shelf");

  // 2. Stats view: today has chars and time from the real session.
  await openStats(page);
  const charsToday = await rowValue(page, "Characters today");
  check(
    /[1-9]/.test(charsToday.replace("Characters today", "")),
    `chars today counted from real reading (${charsToday.trim()})`,
  );
  const timeToday = await rowValue(page, "Time today");
  check(
    /[1-9]/.test(timeToday.replace("Time today", "")),
    `active time counted (${timeToday.trim()})`,
  );
  const streakToday = await rowValue(page, "Streak");
  check(
    streakToday.includes("1 day"),
    `streak starts at one day (${streakToday.trim()})`,
  );

  // 3. Heatmap grid renders; today is colored (level 1+). Future days of the
  // current week render as blanks without the heat class, so the count is
  // 26*7 minus them, plus the 5 legend swatches.
  const cells = await page.locator(".rounded-heat").count();
  check(cells >= 175, `heatmap cells rendered (${cells})`);
  const coloredToday = await page
    .locator('[class*="bg-heat-1"], [class*="bg-heat-2"], [class*="bg-heat-3"], [class*="bg-heat-4"]')
    .count();
  check(coloredToday >= 1, "today's cell is colored (active session)");

  // 4. Seed 4 adjacent past days → streak 5, one more colored cell.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("yuki");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("stats", "readwrite");
    for (let back = 1; back <= 4; back += 1) {
      const d = new Date();
      d.setDate(d.getDate() - back);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      tx.objectStore("stats").put({
        date: key,
        chars: 500,
        pages: 0,
        timeMs: 30 * 60_000,
      });
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  // Revisit the view (it reloads on mount).
  await page.click('button[data-view="library"]');
  await openStats(page);
  const streakSeeded = await rowValue(page, "Streak");
  check(
    streakSeeded.includes("5 days"),
    `seeded history extends the streak to five (${streakSeeded.trim()})`,
  );
  const coloredSeeded = await page
    .locator('[class*="bg-heat-1"], [class*="bg-heat-2"], [class*="bg-heat-3"], [class*="bg-heat-4"]')
    .count();
  check(coloredSeeded >= 5, "seeded days color their heatmap cells");
  const totalRow = await rowValue(page, "Total characters");
  check(
    /[2-9][\s,]?\d{3}|[1-9]\d{3,}/.test(totalRow.replace("Total characters", "")),
    `total chars include the seeded days (${totalRow.trim()})`,
  );

  // 5. Goal stepper: 3,000 → 3,500, survives a reload.
  await page.click('button[aria-label="increase goal"]');
  await page.waitForTimeout(200);
  check(
    (await page.locator("text=3,500").count()) >= 1,
    "goal stepper moves 3,000 → 3,500",
  );
  await page.reload();
  await openStats(page);
  check(
    (await page.locator("text=3,500").count()) >= 1,
    "goal persists across reload",
  );

  // 6. Percent mode: the target scales from the picked book's volume; the
  // picker shows the current read with its cover.
  await page.click('button:text-is("% of book")');
  await page.waitForTimeout(300);
  check(
    (await page.locator('span:text-is("8 %")').count()) >= 1,
    "percent mode defaults to 8 % of the book",
  );
  check(
    (await page.locator("text=% of").count()) >= 1,
    "percent mode shows the book picker line",
  );
  check(
    (await page.locator(`[data-slot="select-trigger"]:has-text("${FILTER}")`).count()) >= 1,
    "picker trigger names the current book",
  );
  const ringText = await page.locator("text=/of .* characters today/").first().textContent();
  check(
    /of\s+\d[\d,]*\s+characters/.test(ringText ?? ""),
    `percent target converts to chars (${(ringText ?? "").trim()})`,
  );

  // 7. The picker opens, lists the imported book with a cover, selects it.
  await page.click('button[aria-label="goal book"]');
  await page.waitForSelector('[data-slot="select-content"]', { timeout: 5_000 });
  check(
    (await page.locator('[data-slot="select-item"]').count()) === 1,
    "picker lists the imported book",
  );
  check(
    (await page.locator('[data-slot="select-content"] img').count()) === 1,
    "picker items show covers",
  );
  await page.click('[data-slot="select-item"]');
  await page.waitForTimeout(300);
  check(
    (await page.locator(`[data-slot="select-trigger"]:has-text("${FILTER}")`).count()) >= 1,
    "picked book stays in the trigger",
  );

  // 8. Per-book stats + speed: attribute a one-hour slice to the imported
  // book, then the stats view shows "Speed today" and the details
  // dialog shows the book's own volume, time and speed.
  const seededBookId = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("yuki");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const booksReq = db.transaction("books", "readonly").objectStore("books").getAll();
    const books = await new Promise<{ id: string }[]>((resolve, reject) => {
      booksReq.onsuccess = () => resolve(booksReq.result as { id: string }[]);
      booksReq.onerror = () => reject(booksReq.error);
    });
    const id = books[0]?.id;
    if (!id) {
      db.close();
      return null;
    }
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const tx = db.transaction("stats", "readwrite");
    const store = tx.objectStore("stats");
    const getReq = store.get(key);
    const current = await new Promise<Record<string, unknown> | undefined>(
      (resolve, reject) => {
        getReq.onsuccess = () =>
          resolve(getReq.result as Record<string, unknown> | undefined);
        getReq.onerror = () => reject(getReq.error);
      },
    );
    const day = current ?? { date: key, chars: 0, pages: 0, timeMs: 0 };
    day.chars = (day.chars as number) + 6_000;
    day.timeMs = (day.timeMs as number) + 3_600_000;
    day.perBook = {
      ...((day.perBook as object | undefined) ?? {}),
      [id]: { chars: 6_000, pages: 0, timeMs: 3_600_000 },
    };
    store.put(day);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return id;
  });
  check(seededBookId !== null, "seeded a one-hour slice for the book");

  await page.click('button[data-view="library"]');
  await openStats(page);
  const speedRow = await rowValue(page, "Speed today");
  check(/ch\/h/.test(speedRow), `today's speed shows (${speedRow.trim()})`);

  await page.click('button[data-view="library"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  await page.locator("[data-book-id]", { hasText: FILTER }).click({ button: "right" });
  await page.click("[role=menu] >> text=Details");
  await page.waitForSelector("[role=dialog]", { timeout: 5_000 });
  await page.waitForTimeout(400); // the book's stats load after the dialog opens
  const detailsText = (await page.locator("[role=dialog]").textContent()) ?? "";
  check(detailsText.includes("Characters read"), "details show the book's read volume");
  check(detailsText.includes("Reading time"), "details show the book's reading time");
  check(
    detailsText.includes("Speed") && /ch\/h/.test(detailsText),
    "details show the book's reading speed",
  );

  await browser.close();
  if (problems.length) {
    console.log(`\nstats-smoke: ${problems.length} problem(s)`);
    problems.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  console.log("\nstats-smoke: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
