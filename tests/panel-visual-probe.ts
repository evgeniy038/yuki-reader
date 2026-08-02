// Visual probe: screenshot the floating reader panel (windowed + fullscreen).
// Usage: pnpm tsx tests/panel-visual-probe.ts

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = "http://localhost:1420";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureServer(): Promise<void> {
  const up = await fetch(BASE).then((r) => r.ok, () => false);
  if (up) return;
  const child = spawn("pnpm", ["dev"], { cwd: process.cwd(), stdio: "ignore", detached: true });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await fetch(BASE).then((r) => r.ok, () => false)) return;
  }
  throw new Error("dev server did not come up on :1420");
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.HEADED !== "1",
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  await page.goto(`${BASE}/?demo=h`);
  await page.waitForSelector(".book-content");
  await page.mouse.move(720, 10);
  await sleep(150);
  await page.click('button[aria-label="Contents"]');
  await page.locator('[data-reader-panel="toc"]').waitFor();
  await sleep(400);
  await page.screenshot({ path: "artifacts/local/browser/screenshots/panel-windowed.png" });

  // Close the panel before fullscreen (the same button toggles).
  await page.mouse.move(720, 10);
  await sleep(150);
  await page.click('button[aria-label="Contents"]');
  await page.locator('[data-reader-panel="toc"]').waitFor({ state: "detached" });

  await page.mouse.move(720, 10);
  await sleep(150);
  await page.click('button[aria-label="Fullscreen"]');
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  await sleep(process.env.HEADED === "1" ? 1400 : 300);
  await page.mouse.move(720, 10);
  await sleep(200);
  await page.click('button[aria-label="Contents"]');
  await page.locator('[data-reader-panel="toc"]').waitFor();
  await sleep(400);
  await page.screenshot({ path: "artifacts/local/browser/screenshots/panel-fullscreen.png" });

  await browser.close();
  console.log("panel-visual-probe: screenshots saved");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
