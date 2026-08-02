// Reader chrome must keep its whole hit area interactive in fullscreen.
// Usage: pnpm tsx tests/reader-chrome-fullscreen-smoke.ts

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright-core";

const BASE = "http://localhost:1420";
const POINTS = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.5, 0.5],
  [0.2, 0.8],
  [0.8, 0.8],
] as const;

async function ensureServer(): Promise<void> {
  const up = await fetch(BASE).then(
    (response) => response.ok,
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
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await fetch(BASE).then((response) => response.ok, () => false)) return;
  }
  throw new Error("dev server did not come up on :1420");
}

async function wakeChrome(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  assert.ok(viewport, "viewport is set");
  await page.mouse.move(viewport.width / 2, 10);
  await page.waitForTimeout(80);
}

async function freshFullscreenReader(page: Page): Promise<void> {
  await page.goto(`${BASE}/?demo=h`);
  await page.waitForSelector(".book-content");
  await wakeChrome(page);
  await clickAt(page, 'button[aria-label="Fullscreen"]', [0.5, 0.5]);
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  // Headed runs ride the real macOS fullscreen transition (~1s) — let it
  // settle, or boxes measured mid-animation no longer match the cursor.
  if (process.env.HEADED === "1") await page.waitForTimeout(1400);
  await wakeChrome(page);
}

async function clickAt(
  page: Page,
  selector: string,
  point: readonly [number, number],
): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} has a box`);
  const x = box.x + box.width * point[0];
  const y = box.y + box.height * point[1];

  const inertAncestor = await page.locator(selector).evaluate((control) => {
    for (let parent = control.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).pointerEvents === "none") return parent.className;
    }
    return null;
  });
  assert.equal(inertAncestor, null, `${selector} has no inert ancestor`);

  const hit = await page.evaluate(
    ({ selector, x, y }) => {
      const control = document.querySelector(selector);
      const target = document.elementFromPoint(x, y);
      return !!control && !!target && control.contains(target);
    },
    { selector, x, y },
  );
  assert.ok(hit, `${selector} catches ${point.join(", ")}`);

  await page.mouse.move(x, y);
  const hovered = await page.locator(selector).evaluate((control) => control.matches(":hover"));
  assert.ok(hovered, `${selector} hovers at ${point.join(", ")}`);
  await page.mouse.click(x, y);
}

async function checkToggle(
  page: Page,
  selector: string,
  name: string,
): Promise<void> {
  for (const point of POINTS) {
    await freshFullscreenReader(page);
    await clickAt(page, selector, point);
    assert.equal(
      await page.locator(selector).getAttribute("aria-pressed"),
      "true",
      `${name} opens at ${point.join(", ")}`,
    );
    await clickAt(page, selector, point);
    assert.equal(
      await page.locator(selector).getAttribute("aria-pressed"),
      "false",
      `${name} closes at ${point.join(", ")}`,
    );
    console.log(`  ✓ ${name} toggles at ${point.join(", ")}`);
  }
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.HEADED !== "1",
  });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await checkToggle(page, 'button[aria-label="Search in book"]', "search");
  await checkToggle(page, 'button[aria-label="Settings"]', "settings");

  for (const point of POINTS) {
    await freshFullscreenReader(page);
    await clickAt(page, 'button[aria-label="Fullscreen"]', point);
    await page.waitForFunction(() => !document.fullscreenElement);
    console.log(`  ✓ fullscreen exits at ${point.join(", ")}`);
  }

  for (const point of POINTS) {
    await freshFullscreenReader(page);
    await clickAt(page, 'button[aria-label="Back to the shelf"]', point);
    await page.waitForFunction(() => !location.hash.startsWith("#/read/"));
    console.log(`  ✓ back exits at ${point.join(", ")}`);
  }

  await freshFullscreenReader(page);
  await page.screenshot({
    path: "artifacts/local/browser/screenshots/reader-chrome-fullscreen.png",
  });
  await context.close();
  await browser.close();
  console.log("reader-chrome-fullscreen-smoke: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
