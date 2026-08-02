// Wheel over an open reader panel must scroll the panel, not page the book.
// Usage: pnpm tsx tests/panel-wheel-smoke.ts

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright-core";

const BASE = "http://localhost:1420";

async function ensureServer(): Promise<void> {
  const up = await fetch(BASE).then((r) => r.ok, () => false);
  if (up) return;
  const child = spawn("pnpm", ["dev"], { cwd: process.cwd(), stdio: "ignore", detached: true });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (await fetch(BASE).then((r) => r.ok, () => false)) return;
  }
  throw new Error("dev server did not come up on :1420");
}

const indicatorText = (page: Page) =>
  page.locator("[data-page-indicator]").innerText();

async function wheelOverPanel(page: Page, name: "toc" | "search"): Promise<void> {
  await page.goto(`${BASE}/?demo=h`);
  await page.waitForSelector(".book-content");
  await page.mouse.move(720, 10);
  await page.waitForTimeout(150);
  await page.click(
    `button[aria-label="${name === "toc" ? "Contents" : "Search in book"}"]`,
  );
  const panel = page.locator(`[data-reader-panel="${name}"]`);
  await panel.waitFor();

  const before = await indicatorText(page);
  // Wheel hard inside the panel: the page must not turn.
  const box = (await panel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  assert.equal(await indicatorText(page), before, `${name}: wheel inside the panel never pages`);
  console.log(`  ✓ ${name}: wheel inside the panel never pages`);

  // Wheel over the page itself still turns (sanity that paging is alive).
  await page.mouse.move(1100, 450);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(400);
  assert.notEqual(await indicatorText(page), before, `${name}: wheel over the page pages`);
  console.log(`  ✓ ${name}: wheel over the page still pages`);
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.HEADED !== "1",
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await wheelOverPanel(page, "toc");
  await wheelOverPanel(page, "search");
  await browser.close();
  console.log("panel-wheel-smoke: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
