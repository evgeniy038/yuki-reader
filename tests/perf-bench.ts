// Speed benchmark: real books through the real UI in headless Chrome, every
// duration timed inside the page (tests/perf-probes.ts). Scenarios:
//   library — EPUB import (one book, then a batch), first open + page turns,
//             reopen, shelf startup with the whole library, memory
//   manga   — volume import (folder+sidecar, zip, cbz, image-only EPUB),
//             open + page turns; OCR model fetches are aborted so the
//             numbers are import-only
//   ocr     — a sidecar-less volume end to end: detect gate, recognition
//             march, pages/min (warm model cache in YUKI_BENCH_PROFILE_DIR)
//   pdf     — import + first page of a scan and a text PDF
//   backup  — export the library, import it into a fresh origin
// Usage (results → JSON, see --out):
//   YUKI_TEST_BASE=http://localhost:1460 YUKI_TEST_EPUB_DIR=… YUKI_TEST_MANGA_DIR=… \
//   YUKI_TEST_PDF_SCAN=… YUKI_TEST_PDF_TEXT=… pnpm tsx tests/perf-bench.ts library manga
// YUKI_BENCH_ENGINE=webkit runs the same scenarios in Playwright's WebKit
// (JavaScriptCore + WebKit's IndexedDB — the closest stand-in for Safari on
// iPhone); it has no long-task API and no CDP, so those numbers stay empty.
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { requireEnv } from "./env.ts";
import { backup, ocr } from "./perf-bench-ocr.ts";
import {
  BASE,
  backToShelf,
  bookInput,
  cleanTemps,
  goShelf,
  mangaFixtures,
  openEpub,
  realFiles,
  results,
  session,
  startup,
  tempProfile,
  turnPages,
  turnStats,
} from "./perf-harness.ts";
import { longTasks, now, round, until, untilStored } from "./perf-probes.ts";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const OUT = outAt >= 0 ? args[outAt + 1] : undefined;
const scenarios = args.filter((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1));

// --- scenarios --------------------------------------------------------------

async function library(): Promise<void> {
  const dir = requireEnv("YUKI_TEST_EPUB_DIR");
  const all = realFiles(dir, /\.epub$/i);
  const small = all.find((p) => p.includes(process.env.YUKI_TEST_EPUB_FILTER ?? "キッチン"));
  if (!small) throw new Error("no small fixture (YUKI_TEST_EPUB_FILTER)");
  const rest = all.filter((p) => p !== small);
  const s = await session(tempProfile());
  const { page } = s;
  await goShelf(page);
  const out: Record<string, unknown> = { books: all.length };

  let t0 = await now(page);
  await page.setInputFiles(bookInput, small);
  const one = await until(page, "tiles", 1);
  out.importOneMs = round(one - t0);
  out.persistOneMs = round((await untilStored(page, "books", 1)) - t0);

  t0 = await now(page);
  await page.setInputFiles(bookInput, rest);
  const batch = await until(page, "tiles", all.length, 300_000);
  const stored = await untilStored(page, "books", all.length);
  out.importBatchMs = round(batch - t0);
  out.persistBatchMs = round(stored - t0);
  out.importBatchBlocked = await longTasks(page, t0, stored);

  const opens: Record<string, unknown> = {};
  for (const title of ["キッチン", "変な家", "すずめの戸締まり", "ハウリング"]) {
    opens[title] = await openEpub(page, title);
    if (title === "キッチン") opens.turns = turnStats(await turnPages(page, "epub"));
    await backToShelf(page, all.length);
  }
  opens.reopenKitchen = await openEpub(page, "キッチン");
  await backToShelf(page, all.length);
  out.open = opens;
  out.startup = await startup(s, all.length);
  results.library = out;
  await s.context.close();
}

async function importManga(
  page: Page,
  files: string[],
  tiles: number,
  volumes = tiles,
): Promise<Record<string, unknown>> {
  const t0 = await now(page);
  await page.setInputFiles('input[accept*=".mokuro"]', files);
  const tile = await until(page, "tiles", tiles, 300_000);
  const stored = await untilStored(page, "manga", volumes, 600_000);
  return {
    tileMs: round(tile - t0),
    persistMs: round(stored - t0),
    blocked: await longTasks(page, t0, stored),
  };
}

async function manga(): Promise<void> {
  const f = await mangaFixtures();
  const s = await session(tempProfile());
  const { page } = s;
  // Import-only numbers: no OCR model download competing for the CPU.
  await s.context.route("**/ocr-models/**", (route) => route.abort());
  await goShelf(page);
  const out: Record<string, unknown> = {};
  results.manga = out;
  out.folderWithSidecar = await importManga(page, f.folderFiles, 1);
  out.zip = await importManga(page, [f.kaguya], 2);
  out.zipKimetsu = await importManga(page, [f.kimetsu], 3);
  // The hi-res cbz's name ("…01（高解像度）") makes a series of its own.
  out.cbzHd = await importManga(page, [f.kaguyaHd], 4);
  out.epubManga = await importManga(page, [f.yani], 5);
  out.startup = await startup(s, 5);

  // Open the sidecar volume straight by URL, then turn pages.
  const id = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("yuki");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const books = await new Promise<{ id: string; addedAt: number }[]>((resolve) => {
      const req = db.transaction("books").objectStore("books").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    // The first import: the folder volume with its sidecar.
    return books.sort((a, b) => a.addedAt - b.addedAt)[0]?.id ?? "";
  });
  const t0 = await now(page);
  await page.evaluate((id) => {
    location.hash = `#/read/${id}`;
  }, id);
  out.openMs = round((await until(page, "mangaPage", 0, 60_000)) - t0);
  out.turns = turnStats(await turnPages(page, "manga"));
  await s.context.close();
}

async function pdf(): Promise<void> {
  const scan = requireEnv("YUKI_TEST_PDF_SCAN");
  const text = requireEnv("YUKI_TEST_PDF_TEXT");
  const s = await session(tempProfile());
  const { page } = s;
  await goShelf(page);
  const out: Record<string, unknown> = {};
  for (const [i, [name, path]] of [["scan", scan], ["text", text]].entries()) {
    const t0 = await now(page);
    await page.setInputFiles(bookInput, path!);
    const tile = await until(page, "tiles", i + 1, 120_000);
    const stored = await untilStored(page, "books", i + 1);
    const title = await page.evaluate(
      () => document.querySelector("[data-book-id]")?.textContent ?? "",
    );
    const o0 = await page.evaluate(() => {
      const at = performance.now();
      document.querySelector<HTMLElement>("[data-book-id]")!.click();
      return at;
    });
    const painted = await until(page, "pdfPage", 0, 60_000);
    out[name!] = {
      title: title.slice(0, 40),
      importMs: round(tile - t0),
      persistMs: round(stored - t0),
      importBlocked: await longTasks(page, t0, stored),
      openMs: round(painted - o0),
    };
    await backToShelf(page, i + 1);
  }
  out.startup = await startup(s, 2);
  results.pdf = out;
  await s.context.close();
}

const ALL: Record<string, () => Promise<void>> = { library, manga, ocr, pdf, backup };

async function main(): Promise<void> {
  const ok = await fetch(BASE).then((r) => r.ok, () => false);
  if (!ok) throw new Error(`no server at ${BASE} — start vite or set YUKI_TEST_BASE`);
  for (const name of scenarios.length ? scenarios : ["library", "manga", "pdf", "backup"]) {
    const run = ALL[name];
    if (!run) throw new Error(`unknown scenario ${name}`);
    console.log(`▶ ${name}`);
    const t = Date.now();
    try {
      await run();
    } finally {
      await cleanTemps();
      console.log(JSON.stringify(results[name], null, 2));
    }
    console.log(`  (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
