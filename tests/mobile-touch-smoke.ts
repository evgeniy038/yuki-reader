// Phone reading smoke: the built-in demo book in a phone-sized Chrome with
// REAL touch input (CDP touch events → pointerType "touch") and the
// iPhone Pro Max safe-area insets emulated. Checks the touch contract:
// controls up on open and clear of the status bar, a middle tap hides and
// shows them (with the scrubber bar), outer bands and swipes turn the page
// in the book's reading direction (vertical Japanese: left = forward;
// horizontal: right = forward), a turn puts the controls away.
// No fixtures. Run: pnpm tsx tests/mobile-touch-smoke.ts

import { chromium, type CDPSession, type Page } from "playwright-core";
import { ensureServer } from "./browser-harness.ts";

const BASE = "http://localhost:1420";
const WIDTH = 440;
const HEIGHT = 956;
const INSETS = { top: 62, bottom: 34, left: 0, right: 0 };

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

async function touch(
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: { x: number; y: number }[],
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

async function tap(cdp: CDPSession, x: number, y: number): Promise<void> {
  await touch(cdp, "touchStart", [{ x, y }]);
  await touch(cdp, "touchEnd", []);
}

async function swipe(cdp: CDPSession, fromX: number, toX: number, y: number): Promise<void> {
  await touch(cdp, "touchStart", [{ x: fromX, y }]);
  for (let i = 1; i <= 8; i++) {
    await touch(cdp, "touchMove", [{ x: fromX + ((toX - fromX) * i) / 8, y }]);
    await new Promise((r) => setTimeout(r, 16));
  }
  await touch(cdp, "touchEnd", []);
}

const pageNumber = (page: Page) =>
  page.evaluate(() =>
    Number(document.querySelector("[data-page-indicator]")?.getAttribute("data-page")),
  );

// The back button is really on top (hit-tested), not just in the DOM.
const controlsUp = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('button[aria-label="Back to the shelf"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(450);
}

await ensureServer(BASE);
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: INSETS } as never);

try {
  // --- vertical Japanese (right-to-left) -------------------------------------
  console.log("vertical demo");
  await page.goto(`${BASE}/?demo`);
  await page.waitForSelector("[data-page-indicator]", { timeout: 20_000 });
  await settle(page);
  check(await controlsUp(page), "controls are up when a book opens on a phone");
  const pillTop = await page.evaluate(
    () => document.querySelector('button[aria-label="Back to the shelf"]')!.getBoundingClientRect().top,
  );
  check(pillTop >= INSETS.top, `control pill clears the status bar (top ${Math.round(pillTop)})`);
  check(
    (await page.locator("[data-page-bar]").count()) === 1,
    "the scrubber bar shows with the controls",
  );

  await tap(cdp, WIDTH / 2, HEIGHT / 2);
  await settle(page);
  check(!(await controlsUp(page)), "middle tap hides the controls");
  check((await page.locator("[data-page-bar]").count()) === 0, "…and the scrubber bar");

  const p0 = await pageNumber(page);
  await tap(cdp, WIDTH * 0.12, HEIGHT / 2);
  await settle(page);
  const p1 = await pageNumber(page);
  check(p1 === p0 + 1, `left band turns forward in a vertical book (${p0} → ${p1})`);

  await swipe(cdp, 80, 340, HEIGHT / 2);
  await settle(page);
  const p2 = await pageNumber(page);
  check(p2 === p1 + 1, `swipe to the right turns forward (${p1} → ${p2})`);

  await swipe(cdp, 340, 80, HEIGHT / 2);
  await settle(page);
  const p3 = await pageNumber(page);
  check(p3 === p2 - 1, `swipe to the left turns back (${p2} → ${p3})`);

  await tap(cdp, WIDTH * 0.88, HEIGHT / 2);
  await settle(page);
  const p4 = await pageNumber(page);
  check(p4 === p3 - 1, `right band turns back (${p3} → ${p4})`);

  // A short, slow drag is not a turn.
  await touch(cdp, "touchStart", [{ x: 200, y: 500 }]);
  for (let i = 1; i <= 6; i++) {
    await touch(cdp, "touchMove", [{ x: 200 + i * 5, y: 500 }]);
    await new Promise((r) => setTimeout(r, 60));
  }
  await touch(cdp, "touchEnd", []);
  await settle(page);
  check((await pageNumber(page)) === p4, "a short slow drag springs back without turning");

  await tap(cdp, WIDTH / 2, HEIGHT / 2);
  await settle(page);
  check(await controlsUp(page), "middle tap brings the controls back");
  await tap(cdp, WIDTH * 0.12, HEIGHT / 2);
  await settle(page);
  check(!(await controlsUp(page)), "a page turn puts the controls away");

  // --- horizontal (left-to-right) ------------------------------------------------
  console.log("horizontal demo");
  await page.goto(`${BASE}/?demo=h`);
  await page.waitForSelector("[data-page-indicator]", { timeout: 20_000 });
  await settle(page);
  const h0 = await pageNumber(page);
  await tap(cdp, WIDTH * 0.88, HEIGHT / 2);
  await settle(page);
  const h1 = await pageNumber(page);
  check(h1 === h0 + 1, `right band turns forward in a horizontal book (${h0} → ${h1})`);
  await swipe(cdp, 340, 80, HEIGHT / 2);
  await settle(page);
  const h2 = await pageNumber(page);
  check(h2 === h1 + 1, `swipe to the left turns forward (${h1} → ${h2})`);
  await tap(cdp, WIDTH * 0.12, HEIGHT / 2);
  await settle(page);
  check((await pageNumber(page)) === h1, "left band turns back");

  // --- the field focus zoom guard ---------------------------------------------
  const fontSize = await page.evaluate(() => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const size = getComputedStyle(input).fontSize;
    input.remove();
    return size;
  });
  check(fontSize === "16px", `fields render at 16px on touch (no iOS focus zoom) — ${fontSize}`);
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.log(`\nmobile-touch-smoke: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nmobile-touch-smoke: all checks passed");
