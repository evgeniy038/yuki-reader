// Perf probe for the book pipeline: end-to-end timings in the REAL app
// (headless system Chrome, playwright-core) plus the pure EPUB parse in node.
// Numbers per book, so optimizations are verified, not guessed.
//   parseMs  — node-side parseEpub(bytes), median of 3 runs
//   importMs — file input → the fresh tile is on the shelf (unzip/parse,
//              cover, hash, language; the IndexedDB write is fire-and-forget)
//   openMs   — tile click → first settled reader paint (article laid out,
//              fonts and images ready, page indicator live / PDF canvas on
//              screen)
// Dev server is spawned if absent. Usage: pnpm tsx tests/perf-probe.ts [filter]
// (YUKI_BASE=http://localhost:1421 … to measure the production preview build).

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { parseEpub } from "../src/core/epub";

const NOVELS_DIR = requireEnv("YUKI_TEST_EPUB_DIR");
const PDFS = [process.env.YUKI_TEST_PDF_TEXT, process.env.YUKI_TEST_PDF_SCAN].filter(
  (p): p is string => typeof p === "string" && existsSync(p),
);
const FILTER = process.argv[2] ?? "";
// Point at a production preview (pnpm build && pnpm preview --port 1421) with
// YUKI_BASE=http://localhost:1421 — dev StrictMode double-layout skews openMs.
const BASE = process.env.YUKI_BASE ?? "http://localhost:1420";

async function ensureServer(): Promise<void> {
  const up = await fetch(BASE).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return;
  const child = spawn("pnpm", ["dev"], { cwd: process.cwd(), stdio: "ignore", detached: true });
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

function nodeParseMs(file: string): number {
  const bytes = new Uint8Array(readFileSync(join(NOVELS_DIR, file)));
  const times: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    parseEpub(bytes);
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[1]!;
}

async function waitForEpubPaint(page: Page): Promise<void> {
  await page.waitForSelector(".book-content > *", { state: "attached", timeout: 60_000 });
  await page.waitForFunction(
    () => Number(document.querySelector("[data-page-indicator]")?.getAttribute("data-pages")) >= 1,
    { timeout: 60_000 },
  );
}

async function waitForPdfPaint(page: Page): Promise<void> {
  await page.waitForSelector("[data-pdf-page] canvas", { timeout: 60_000 });
}

async function main(): Promise<void> {
  await ensureServer();
  const epubs = readdirSync(NOVELS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".epub"))
    .filter((f) => (FILTER === "" ? true : f.includes(FILTER)))
    .sort();

  const rows: string[] = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  for (const file of epubs) {
    const name = file.length > 44 ? `${file.slice(0, 41)}…` : file;
    const parseMs = nodeParseMs(file).toFixed(0);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(BASE);
      const t0 = performance.now();
      await page.setInputFiles('input[accept*="epub"]', join(NOVELS_DIR, file));
      await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
      const importMs = (performance.now() - t0).toFixed(0);
      const t1 = performance.now();
      await page.locator("[data-book-id]").first().click();
      await waitForEpubPaint(page);
      const openMs = (performance.now() - t1).toFixed(0);
      rows.push(`${name}  parse=${parseMs}ms  import=${importMs}ms  open=${openMs}ms`);
    } catch (err) {
      rows.push(`${name}  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    await context.close();
  }

  for (const pdfPath of PDFS) {
    const file = pdfPath.split("/").pop()!;
    const name = file.length > 44 ? `${file.slice(0, 41)}…` : file;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(BASE);
      const t0 = performance.now();
      await page.setInputFiles('input[accept*="pdf"]', pdfPath);
      await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
      const importMs = (performance.now() - t0).toFixed(0);
      const t1 = performance.now();
      await page.locator("[data-book-id]").first().click();
      await waitForPdfPaint(page);
      const openMs = (performance.now() - t1).toFixed(0);
      rows.push(`${name}  import=${importMs}ms  open=${openMs}ms`);
    } catch (err) {
      rows.push(`${name}  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    await context.close();
  }

  await browser.close();
  for (const row of rows) console.log(row);
}

await main();
