// Phone reading smoke: the built-in demo book in a phone-sized Chrome with
// REAL touch input (CDP touch events → pointerType "touch") and the
// iPhone Pro Max safe-area insets emulated. Checks the touch contract:
// controls up on open and clear of the status bar, a middle tap hides and
// shows them (with the scrubber bar), outer bands and swipes turn the page
// in the book's reading direction (vertical Japanese: left = forward;
// horizontal: right = forward), a turn puts the controls away; and the
// page-turn animation switch — on, a turn slides and the page follows the
// finger; off, it just flips — in the text reader and on the manga pager;
// and zoomed manga moves without a jump: double-tap zoom, a released pan and
// a pan let go past the page edge, measured frame by frame.
// No fixtures (the manga volume is drawn on the fly).
// Run: pnpm tsx tests/mobile-touch-smoke.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import sharp from "sharp";
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

/** A finger that went down and whose lift the page never heard — what iOS
    does when you switch apps mid-touch (copy an OCR line, open a translator,
    come back). */
const ghostTouch = (page: Page, x: number, y: number) =>
  page.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y)?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 4242, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }),
    );
  }, { x, y });

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
  await ghostTouch(page, 200, 500);
  const beforeGhost = await pageNumber(page);
  await tap(cdp, WIDTH * 0.12, HEIGHT / 2);
  await settle(page);
  check((await pageNumber(page)) === beforeGhost + 1, "after a touch whose lift got lost (an app switch), the next tap still turns");

  // --- the page-turn animation: on by default, a switch in Settings -----------
  // Slides are Web Animations on the page box; a drag moves it by transform.
  const slides = () =>
    page.evaluate(() =>
      document.getAnimations().filter((a) =>
        a.effect instanceof KeyframeEffect &&
        a.effect.getKeyframes().some((k) => String(k.transform ?? "").includes("translateX")),
      ).length,
    );
  const followsFinger = async () => {
    await touch(cdp, "touchStart", [{ x: 200, y: 500 }]);
    for (let i = 1; i <= 4; i++) {
      await touch(cdp, "touchMove", [{ x: 200 + i * 10, y: 500 }]);
      await new Promise((r) => setTimeout(r, 60));
    }
    const moved = await page.evaluate(() => document.querySelector('[style*="translateX"]') !== null);
    await touch(cdp, "touchEnd", []);
    await settle(page);
    return moved;
  };
  const before = await pageNumber(page);
  await tap(cdp, WIDTH * 0.12, HEIGHT / 2);
  check((await slides()) > 0, "with the animation on, a turn slides in");
  await settle(page);
  check(await followsFinger(), "…and the page follows the finger");
  await page.goto(`${BASE}/#/settings`);
  await page.getByRole("switch", { name: "Page-turn animation" }).click();
  await page.goto(`${BASE}/?demo`);
  await page.waitForSelector("[data-page-indicator]", { timeout: 20_000 });
  await settle(page);
  await tap(cdp, WIDTH / 2, HEIGHT / 2); // controls away
  await settle(page);
  const still = await pageNumber(page);
  await tap(cdp, WIDTH * 0.12, HEIGHT / 2);
  check((await slides()) === 0, "with the animation off, a turn just flips — no slide");
  await settle(page);
  check((await pageNumber(page)) === still + 1, `…and still turns (${still} → ${still + 1})`);
  check(!(await followsFinger()), "…and the page stays put under the finger");
  await swipe(cdp, 80, 340, HEIGHT / 2);
  await settle(page);
  check((await pageNumber(page)) === still + 2, "…while a swipe still turns it");
  void before;

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

  // --- manga: the same switch on the pager track (off now, then on) -----------
  console.log("manga");
  const scans = mkdtempSync(join(tmpdir(), "yuki-touch-"));
  const pages: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const path = join(scans, `p${i}.png`);
    await sharp({ create: { width: 600, height: 860, channels: 3, background: `#${(i * 40).toString(16)}5599` } }).png().toFile(path);
    pages.push(path);
  }
  const sidecar = join(scans, "めくり 第01巻.mokuro");
  writeFileSync(sidecar, JSON.stringify({
    version: "0.2.1", title: "めくり", volume: "めくり 第01巻",
    pages: pages.map((_, i) => ({ img_path: `p${i + 1}.png`, img_width: 600, img_height: 860, blocks: [{ box: [20, 20, 120, 160], vertical: true, font_size: 24, lines: ["め"] }] })),
  }));
  await page.goto(`${BASE}/#/`);
  await page.setInputFiles('input[accept*=".mokuro"]', [...pages, sidecar]);
  await page.locator("[data-book-id]").filter({ hasText: "めくり" }).first().waitFor({ timeout: 60_000 });
  rmSync(scans, { recursive: true, force: true });
  const mangaPage = () => page.evaluate(() => document.querySelector("[data-manga-page]")?.getAttribute("data-manga-page"));
  // The track is the slots' parent (neighbour slots sit at ±100% on their own).
  const trackAway = () =>
    page.evaluate(() => {
      const track = document.querySelector("[data-manga-current]")?.parentElement?.parentElement;
      return !!track && track.style.transform !== "" && track.style.transform !== "translateX(0px)";
    });
  for (const animated of [false, true]) {
    const mode = animated ? "on" : "off";
    if (animated) {
      await page.goto(`${BASE}/#/settings`);
      await page.getByRole("switch", { name: "Page-turn animation" }).click();
    }
    await page.goto(`${BASE}/#/`);
    await page.locator("[data-book-id]").filter({ hasText: "めくり" }).first().click();
    await page.waitForURL(/#\/manga\//, { timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.locator("[data-book-id]").first().click();
    await page.waitForSelector("[data-manga-current] img", { timeout: 30_000 });
    await page.waitForTimeout(1_200);
    await tap(cdp, WIDTH / 2, HEIGHT / 2); // controls away
    await settle(page);
    const m0 = await mangaPage();
    await touch(cdp, "touchStart", [{ x: 150, y: 500 }]);
    for (let i = 1; i <= 5; i++) {
      await touch(cdp, "touchMove", [{ x: 150 + i * 12, y: 500 }]);
      await new Promise((r) => setTimeout(r, 40));
    }
    const followed = await trackAway();
    await touch(cdp, "touchEnd", []);
    await settle(page);
    check(followed === animated, `manga, animation ${mode}: the page ${animated ? "follows" : "stays put under"} the finger`);
    check((await mangaPage()) === m0, `manga, animation ${mode}: a short drag doesn't turn`);
    await tap(cdp, WIDTH * 0.1, HEIGHT / 2);
    await new Promise((r) => setTimeout(r, 30));
    const sliding = await trackAway();
    await settle(page);
    const m1 = await mangaPage();
    check(m1 !== m0, `manga, animation ${mode}: a tap turns (${m0} → ${m1})`);
    check(sliding === animated, `manga, animation ${mode}: the turn ${animated ? "slides" : "just flips"}`);
    await swipe(cdp, 80, 360, HEIGHT / 2);
    await settle(page);
    check((await mangaPage()) !== m1 && !(await trackAway()), `manga, animation ${mode}: a swipe turns and the track comes home`);
    await ghostTouch(page, 200, 500);
    const m2 = await mangaPage();
    await swipe(cdp, 80, 360, HEIGHT / 2);
    await settle(page);
    const unzoomed = await page.evaluate(() => {
      const layer = document.querySelector<HTMLElement>("[data-manga-current]");
      const t = layer ? getComputedStyle(layer).transform : "none";
      return t === "none" || t.startsWith("matrix(1, 0, 0, 1");
    });
    check((await mangaPage()) !== m2 && unzoomed, `manga, animation ${mode}: after a lost touch (an app switch), a swipe still turns — no ghost pinch`);
  }

  // --- zoomed manga: released motion has no jump -------------------------------
  // Regression (phone recording): every release ended in one frame that
  // covered half the way, then froze. Records the live transform each frame.
  console.log("manga zoom motion");
  // A string: tsx wraps named functions in a helper the page doesn't have.
  const record = () =>
    page.evaluate(`(() => {
      const frames = [];
      window.__frames = frames;
      const tick = () => {
        const style = document.querySelector("[data-manga-current]")?.style.transform ?? "";
        const m = /translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\) scale\\((-?[\\d.]+)\\)/.exec(style);
        frames.push(m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : { x: 0, y: 0, z: 1 });
        if (frames.length < 240) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
  const recorded = () =>
    page.evaluate(() => (window as unknown as { __frames: { x: number; y: number; z: number }[] }).__frames);
  const largestStep = (values: number[]) =>
    Math.max(0, ...values.slice(1).map((value, i) => Math.abs(value - values[i]!)));
  const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within;

  // A tap first closes an OCR box the swipes above may have left open.
  await tap(cdp, WIDTH / 2, HEIGHT / 2);
  await settle(page);
  await record();
  await tap(cdp, WIDTH / 2, HEIGHT / 2);
  await new Promise((r) => setTimeout(r, 60));
  await tap(cdp, WIDTH / 2, HEIGHT / 2);
  await new Promise((r) => setTimeout(r, 1_000));
  const zoomIn = (await recorded()).map((f) => f.z);
  const zoomTo = zoomIn.at(-1) ?? 1;
  check(zoomTo > 2, `double tap zooms in (to ${zoomTo.toFixed(2)})`);
  const zoomStep = largestStep(zoomIn) / Math.max(0.01, zoomTo - 1);
  check(zoomStep < 0.3, `double tap zoom has no jump (largest frame ${(zoomStep * 100).toFixed(0)}% of the way)`);

  // A flick at about 12 px per 16 ms, released while moving.
  await touch(cdp, "touchStart", [{ x: 150, y: 500 }]);
  for (let i = 1; i <= 8; i++) {
    await touch(cdp, "touchMove", [{ x: 150 + i * 12, y: 500 }]);
    await new Promise((r) => setTimeout(r, 16));
  }
  const atRelease = await page.evaluate(() => {
    const style = document.querySelector<HTMLElement>("[data-manga-current]")?.style.transform ?? "";
    return Number(/translate\((-?[\d.]+)px/.exec(style)?.[1] ?? "0");
  });
  await record();
  await touch(cdp, "touchEnd", []);
  await new Promise((r) => setTimeout(r, 1_500));
  const glide = (await recorded()).map((f) => f.x);
  const glideEnd = glide.at(-1) ?? 0;
  check(glideEnd - atRelease > 30, `a released pan glides on (${atRelease.toFixed(0)} → ${glideEnd.toFixed(0)} px)`);
  check(largestStep(glide) < 30, `the glide has no jump (largest frame ${largestStep(glide).toFixed(1)} px)`);

  // Dragged far past the edge and held still: eases back from rest.
  const maxX = await page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>("[data-manga-current]");
    const stage = layer?.parentElement?.parentElement?.parentElement;
    const zoomNow = Number(/scale\(([\d.]+)\)/.exec(layer?.style.transform ?? "")?.[1] ?? "1");
    return ((layer?.offsetWidth ?? 0) * zoomNow - (stage?.clientWidth ?? 0)) / 2;
  });
  await touch(cdp, "touchStart", [{ x: 20, y: 500 }]);
  for (let i = 1; i <= 20; i++) {
    await touch(cdp, "touchMove", [{ x: 20 + i * 40, y: 500 }]);
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 250));
  await record();
  await touch(cdp, "touchEnd", []);
  await new Promise((r) => setTimeout(r, 1_500));
  const back = (await recorded()).map((f) => f.x);
  const backFrom = back[0] ?? 0;
  const backEnd = back.at(-1) ?? 0;
  check(backFrom > maxX + 5, `the page stretches past its edge (${backFrom.toFixed(0)} > ${maxX.toFixed(0)} px)`);
  check(near(backEnd, maxX, 0.5), `let go past the edge, it comes to rest on it (${backEnd.toFixed(1)} px)`);
  check(
    largestStep(back) < (backFrom - maxX) * 0.3,
    `…with no jump (largest frame ${largestStep(back).toFixed(1)} of ${(backFrom - maxX).toFixed(0)} px)`,
  );

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
