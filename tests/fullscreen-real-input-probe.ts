// Real-input probe: drives the ACTUAL system cursor (swift/CoreGraphics, HID
// level) in a headed native-fullscreen window and checks whether the reader
// chrome responds. This is the scenario CDP-synthetic input cannot see:
// Chrome's own fullscreen UI slides over the top strip on real cursor entry.
// Usage: pnpm tsx tests/fullscreen-real-input-probe.ts
// NOTE: moves the real mouse for a few seconds.

import { execFileSync } from "node:child_process";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function realPointer(mode: "move" | "click", x: number, y: number): void {
  const out = execFileSync("swift", ["tests/cgpointer.swift", mode, String(x), String(y)], {
    stdio: "pipe",
  });
  console.log(`  real ${mode} → ${String(out).trim()} (wanted ${x},${y})`);
}

async function pillState(page: Page) {
  return page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>(
      ".rounded-pill.absolute, .rounded-pill.fixed",
    );
    if (!pill) return { error: "no pill" } as const;
    const r = pill.getBoundingClientRect();
    const gear = pill.querySelector('button[aria-label="Settings"]');
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      pillHover: pill.matches(":hover"),
      gearHover: gear?.matches(":hover") ?? null,
      gearPressed: gear?.getAttribute("aria-pressed"),
      hitTag: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : "null",
      pe: getComputedStyle(pill).pointerEvents,
      opacity: getComputedStyle(pill).opacity,
    } as const;
  });
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  await page.goto(`${BASE}/?demo=h`);
  await page.waitForSelector(".book-content");
  // Record every real mousemove the page receives (coords + count).
  await page.evaluate(() => {
    (window as unknown as { __moves: number[][] }).__moves = [];
    window.addEventListener("mousemove", (e) => {
      const m = (window as unknown as { __moves: number[][] }).__moves;
      m.push([e.clientX, e.clientY]);
      if (m.length > 50) m.shift();
    });
  });
  // Show the pill synthetically, enter fullscreen.
  await page.mouse.move(720, 10);
  await sleep(200);
  await page.click('button[aria-label="Fullscreen"]');
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  await sleep(1600); // native space transition

  const before = await pillState(page);
  console.log("pill before real input:", JSON.stringify(before));
  if ("error" in before) throw new Error("pill not found");
  const cx = before.rect.x + before.rect.w / 2;
  const cy = before.rect.y + before.rect.h / 2;

  // Keep the pill shown regardless of real-event delivery: synthetic poke.
  await page.mouse.move(cx, 10);

  // 1. Real cursor to the very top edge (what a user does to reach the pill).
  realPointer("move", cx, 6);
  await sleep(900); // Chrome fullscreen UI slides down
  // 2. Real cursor onto the pill center.
  realPointer("move", cx, cy);
  await sleep(500);
  const hover = await pillState(page);
  console.log("pill under REAL cursor:", JSON.stringify(hover));
  console.log(
    "moves page saw:",
    JSON.stringify(await page.evaluate(() => (window as unknown as { __moves: number[][] }).__moves.slice(-8))),
  );

  // 3. Real click on the gear.
  realPointer("click", cx, cy);
  await sleep(400);
  const afterClick = await pillState(page);
  console.log("after REAL click:", JSON.stringify(afterClick));

  // 4. Control: real hover over the page indicator (bottom-right) — proves
  // the rest of the page receives real input in fullscreen.
  const ind = await page.locator("[data-page-indicator]").boundingBox();
  let indicatorHover: boolean | string = "no indicator";
  if (ind) {
    realPointer("move", ind.x + ind.width / 2, ind.y + ind.height / 2);
    await sleep(500);
    indicatorHover = await page
      .locator("[data-page-indicator]")
      .evaluate((el) => el.matches(":hover"));
  }
  console.log("page-indicator under REAL cursor:", indicatorHover);

  await browser.close();

  const pillDead = hover.pillHover === false && hover.gearHover === false;
  const clickDead = afterClick.gearPressed !== "true";
  console.log(
    pillDead || clickDead
      ? "REAL-INPUT PROBE: pill is DEAD in native fullscreen"
      : "REAL-INPUT PROBE: pill responds to real input",
  );
  process.exit(pillDead || clickDead ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
