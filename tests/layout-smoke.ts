// Autonomous layout checker for the paginated reader. Drives the REAL app in
// headless system Chrome (playwright-core, channel "chrome" — no browser
// download): imports each epub through the app's file input, waits for render,
// then asserts pagination geometry —
//   1. column pitch is exact (scrollSize = N·pitch − gap)
//   2. no glyph rect crosses a page fold or sits in the inter-page gap
//   3. keyboard paging moves exactly one pitch per press
//   4. all of the above still holds after a window resize (any scale)
// Runs against the deterministic ?demo books first (vertical + horizontal),
// then every epub in the novels folder. Dev server is spawned if absent.
// Usage: pnpm test:layout [substring filter]

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const NOVELS_DIR = process.argv[2] ?? requireEnv("YUKI_TEST_EPUB_DIR");
const FILTER = process.argv[3] ?? "";
const BASE = "http://localhost:1420";
const GAP = 40;
const EPS = 0.75;

interface Violation {
  kind: string;
  page: number;
  offset: number;
  text: string;
}

interface Report {
  vertical: boolean;
  viewport: number;
  scrollSize: number;
  pitch: number;
  pages: number;
  pitchRemainder: number;
  indicator: string;
  indicatorPages: number;
  fontSize: number;
  checkedRects: number;
  violations: Violation[];
  error?: string;
}

const collectReport = (): Report | { error: string } => {
  const GAP_I = 40;
  const EPS_I = 0.75;
  const article = document.querySelector(".book-content");
  if (!article?.parentElement) return { error: "no .book-content" };
  const contentEl = article.parentElement;
  const scrollEl = contentEl.parentElement;
  if (!scrollEl) return { error: "no scroll element" };

  const vertical = getComputedStyle(contentEl).writingMode.includes("vertical");
  const viewport = vertical ? scrollEl.clientHeight : scrollEl.clientWidth;
  const scrollSize = vertical ? scrollEl.scrollHeight : scrollEl.scrollWidth;
  const pitch = viewport + GAP_I;
  const pages = Math.max(1, Math.round((scrollSize + GAP_I) / pitch));
  const pitchRemainder = (scrollSize + GAP_I) % pitch;
  const indicatorEl = document.querySelector("[data-page-indicator]");
  const indicator = indicatorEl?.textContent?.trim() ?? "";
  const indicatorPages = Number(indicatorEl?.getAttribute("data-pages"));

  const sRect = scrollEl.getBoundingClientRect();
  const scrollOffset = vertical ? scrollEl.scrollTop : scrollEl.scrollLeft;
  const fontSize = parseFloat(getComputedStyle(contentEl).fontSize) || 18;
  const violations: Violation[] = [];
  let checkedRects = 0;

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const current = node;
    node = walker.nextNode();
    const value = current.nodeValue ?? "";
    const el = current.parentElement;
    if (value.trim() === "" || !el || el.closest("rt") || el.closest("rp")) continue;
    const range = document.createRange();
    // Measure only visible glyphs: trailing/leading whitespace at a line edge
    // HANGS past the edge per CSS Text (right-aligned colophon lines pad with
    // full-width spaces) — it is invisible and cannot be cut by a page fold.
    const leadWs = value.length - value.trimStart().length;
    range.setStart(current, leadWs);
    range.setEnd(current, value.trimEnd().length);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0 && rect.height === 0) continue;
      checkedRects++;
      const start =
        (vertical ? rect.top : rect.left) -
        (vertical ? sRect.top : sRect.left) +
        scrollOffset;
      const end =
        (vertical ? rect.bottom : rect.right) -
        (vertical ? sRect.top : sRect.left) +
        scrollOffset;
      if (start < -EPS_I || end > scrollSize + EPS_I) {
        // Same kinsoku tolerance at the very end of the book: the hang past
        // the final column is clipped (multicol quirk), ≤1 glyph only.
        if (start >= -EPS_I && end - scrollSize <= fontSize + EPS_I) continue;
        if (violations.length < 25)
          violations.push({
            kind: "out-of-flow",
            page: Math.max(0, Math.floor(start / pitch)),
            offset: Math.round(start),
            text: value.trim().slice(0, 24),
          });
        continue;
      }
      const crossesFold =
        Math.floor(start / pitch) !== Math.floor((end - EPS_I) / pitch);
      const startInGap = start % pitch > viewport + EPS_I;
      const endInGap = (end - EPS_I) % pitch > viewport + EPS_I;
      if (!crossesFold && !startInGap && !endInGap) continue;
      // Kinsoku tolerance: closing punctuation (、。！？) may not start a new
      // line, so the browser lets it — or a trailing full-width space after it —
      // hang past the column edge by up to one glyph (+ subpixel). The 40px gap
      // absorbs it — legitimate typography, not a bug.
      const pageEnd = Math.floor(start / pitch) * pitch + viewport;
      const overhang = Math.max(0, end - pageEnd);
      if (overhang <= fontSize + EPS_I) continue;
      if (violations.length < 25) {
        violations.push({
          kind: crossesFold ? "crosses-fold" : "in-gap",
          page: Math.floor(start / pitch),
          offset: Math.round(start % pitch),
          text: `${value.trim().slice(0, 20)} (+${Math.round(overhang)}px)`,
        });
      }
    }
  }

  // Illustrations: replaced elements are always valid break points, so an img
  // never legitimately hangs — no kinsoku tolerance, the page box is strict.
  for (const img of article.querySelectorAll("img, svg")) {
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    checkedRects++;
    const start =
      (vertical ? rect.top : rect.left) -
      (vertical ? sRect.top : sRect.left) +
      scrollOffset;
    const end =
      (vertical ? rect.bottom : rect.right) -
      (vertical ? sRect.top : sRect.left) +
      scrollOffset;
    const outOfFlow = start < -EPS_I || end > scrollSize + EPS_I;
    const crossesFold =
      !outOfFlow && Math.floor(start / pitch) !== Math.floor((end - EPS_I) / pitch);
    const inGap =
      !outOfFlow &&
      !crossesFold &&
      (start % pitch > viewport + EPS_I || (end - EPS_I) % pitch > viewport + EPS_I);
    if (!outOfFlow && !crossesFold && !inGap) continue;
    if (violations.length < 25) {
      violations.push({
        kind: outOfFlow ? "img-out-of-flow" : crossesFold ? "img-crosses-fold" : "img-in-gap",
        page: Math.max(0, Math.floor(start / pitch)),
        offset: Math.round(start % pitch),
        text: `${img.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)} ${(img.getAttribute("src") ?? "").slice(-32)}`,
      });
    }
  }
  return {
    vertical,
    viewport,
    scrollSize,
    pitch,
    pages,
    pitchRemainder,
    indicator,
    indicatorPages,
    fontSize,
    checkedRects,
    violations,
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
      Array.from(document.querySelectorAll<HTMLImageElement>(".book-content img")).map(
        (img) =>
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

// The reader re-measures via ResizeObserver → rAF, so right after a resize the
// column geometry can lag the viewport for a frame or two. Wait until the
// re-measure has actually landed (column width matches the new page box and
// the pitch divides exactly) before collecting a report.
async function waitForSettledGeometry(page: Page): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const settled = await page.evaluate(() => {
      const article = document.querySelector(".book-content");
      const contentEl = article?.parentElement;
      const scrollEl = contentEl?.parentElement;
      const outerEl = scrollEl?.parentElement;
      if (!article || !contentEl || !scrollEl || !outerEl) return false;
      const vertical = getComputedStyle(contentEl).writingMode.includes("vertical");
      const viewport = vertical ? scrollEl.clientHeight : scrollEl.clientWidth;
      // Guard against pre-measure staleness: the scroll box must already have
      // been resized to the CURRENT outer box (vertical page box = outer − 2·40).
      const expected = vertical ? outerEl.clientHeight - 80 : outerEl.clientWidth;
      if (Math.abs(viewport - expected) > 1) return false;
      const scrollSize = vertical ? scrollEl.scrollHeight : scrollEl.scrollWidth;
      const columnW = parseFloat(getComputedStyle(contentEl).columnWidth);
      if (!viewport || !scrollSize || Number.isNaN(columnW)) return false;
      // Sub-glyph trailing overflow (kinsoku ink at the flow end) is tolerated
      // by the report too — don't block settling on it.
      const fontSize = parseFloat(getComputedStyle(contentEl).fontSize) || 18;
      if ((scrollSize + 40) % (viewport + 40) > fontSize) return false;
      // The React page-count indicator re-renders a tick after measure() —
      // require it to agree with the geometry before collecting a report.
      const indicated = Number(
        document.querySelector("[data-page-indicator]")?.getAttribute("data-pages"),
      );
      const pages = Math.max(1, Math.round((scrollSize + 40) / (viewport + 40)));
      return Math.abs(columnW - viewport) < 1 && indicated === pages;
    });
    if (settled) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function scrollPos(page: Page): Promise<number> {
  return page.evaluate(() => {
    const contentEl = document.querySelector(".book-content")?.parentElement;
    const scrollEl = contentEl?.parentElement;
    if (!contentEl || !scrollEl) return -1;
    return getComputedStyle(contentEl).writingMode.includes("vertical")
      ? scrollEl.scrollTop
      : scrollEl.scrollLeft;
  });
}

function reportProblems(name: string, report: Report): string[] {
  const problems: string[] = [];
  if (report.error) return [report.error];
  // Trailing kinsoku ink at the flow end legitimately inflates scrollSize by
  // less than one glyph — same tolerance as the glyph checks. Anything larger
  // means a real element breaks the page grid (and the rect walk flags it).
  if (report.pitchRemainder > report.fontSize)
    problems.push(
      `pitch not exact: (scrollSize+gap) % pitch = ${report.pitchRemainder} (scrollSize=${report.scrollSize}, pitch=${report.pitch})`,
    );
  if (report.indicatorPages && report.indicatorPages !== report.pages)
    problems.push(`indicator says ${report.indicatorPages} pages, geometry says ${report.pages}`);
  if (report.violations.length > 0)
    problems.push(
      `${report.violations.length} glyph violations: ${report.violations
        .slice(0, 5)
        .map((v) => `${v.kind}@p${v.page}+${v.offset} "${v.text}"`)
        .join(" | ")}`,
    );
  if (report.checkedRects === 0) problems.push("no text rects found — book rendered empty?");
  return problems.map((p) => `${name}: ${p}`);
}

async function checkPage(
  page: Page,
  name: string,
  forwardKey: string,
  backKey: string,
): Promise<string[]> {
  const problems: string[] = [];
  await waitForReader(page);
  await waitForSettledGeometry(page);

  const report = (await page.evaluate(collectReport)) as Report;
  problems.push(...reportProblems(name, report));

  // Keyboard paging: two steps forward, one back — position must move by pitch.
  if (!report.error) {
    const sectionId = async () =>
      page
        .locator(".book-content > *")
        .first()
        .getAttribute("data-chapter");
    const start = await scrollPos(page);
    const startSection = await sectionId();
    await page.keyboard.press(forwardKey);
    await page.waitForTimeout(80);
    await page.keyboard.press(forwardKey);
    await page.waitForTimeout(80);
    const afterTwo = await scrollPos(page);
    // Crossing into another section re-renders and lands on its first page,
    // so the pitch assert only holds within a single section.
    const crossed = (await sectionId()) !== startSection;
    if (!crossed) {
      const expected = Math.min(
        start + 2 * report.pitch,
        report.scrollSize - report.viewport,
      );
      if (Math.abs(afterTwo - expected) > 1)
        problems.push(
          `${name}: 2 flips moved ${afterTwo - start}px, expected ${expected - start}px (pitch=${report.pitch})`,
        );
    }
    await page.keyboard.press(backKey);
    await page.waitForTimeout(80);
  }

  // Resize: geometry must re-measure and stay pitch-exact at any scale.
  await page.setViewportSize({ width: 1010, height: 730 });
  await waitForSettledGeometry(page);
  const resized = (await page.evaluate(collectReport)) as Report;
  problems.push(...reportProblems(`${name} [resized]`, resized));

  return problems;
}

async function main(): Promise<void> {
  await ensureServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const allProblems: string[] = [];

  // Deterministic demo books first: vertical (ja) and horizontal (en).
  for (const demo of [
    { url: `${BASE}/?demo`, name: "demo-vertical", fwd: "ArrowLeft", bwd: "ArrowRight" },
    { url: `${BASE}/?demo=h`, name: "demo-horizontal", fwd: "ArrowRight", bwd: "ArrowLeft" },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(demo.url);
    allProblems.push(...(await checkPage(page, demo.name, demo.fwd, demo.bwd)));
    await context.close();
    console.log(`checked ${demo.name}`);
  }

  const epubs = readdirSync(NOVELS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".epub"))
    .filter((f) => (FILTER === "" ? true : f.includes(FILTER)))
    .sort();
  console.log(`checking ${epubs.length} epubs from ${NOVELS_DIR}`);

  for (const file of epubs) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const name = file.length > 40 ? `${file.slice(0, 37)}…` : file;
    try {
      await page.goto(BASE);
      await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, file));
      allProblems.push(...(await checkPage(page, name, "ArrowLeft", "ArrowRight")));
      console.log(`checked ${name}`);
    } catch (err) {
      allProblems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`FAILED  ${name}`);
    }
    await context.close();
  }

  await browser.close();
  if (allProblems.length > 0) {
    console.log(`\nLAYOUT CHECK: FAIL (${allProblems.length} problems)`);
    for (const p of allProblems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log("\nLAYOUT CHECK: PASS");
}

await main();
