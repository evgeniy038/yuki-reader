// Generic OCR scheduling benchmark harness.
//
// Drives the REAL reader (dev or preview server) over a real fixture and
// measures the whole OCR pipeline from storage truth (IndexedDB), never from
// queue length and never by title — the fixture is a path, the volume is
// discovered as "the manga book that just appeared". Nothing is hardcoded to
// one manga; the app's own importer strips archive roots and filters images.
//
// Fixture (exactly one):
//   YUKI_BENCH_ZIP   path to a .zip/.cbz archive (one volume; nested roots
//                    and .url junk are handled by the app's importer)
//   YUKI_BENCH_DIR   path to a folder of loose page scans (one volume)
//
// Knobs:
//   YUKI_TEST_BASE          server URL (default http://localhost:1422)
//   YUKI_BENCH_POOL         ?ocrPool=N override (1..6)
//   YUKI_BENCH_THREADS      ?ocrThreads=M override
//   YUKI_BENCH_EP           force wasm|webgpu (default: app auto-detect)
//   YUKI_BENCH_PROFILE_DIR  persistent chromium profile dir. Unset = a fresh
//                           temp dir (COLD: models download). Reusing a dir
//                           that already ran once = WARM (models in IndexedDB).
//   YUKI_BENCH_COLLECT_S    min seconds to sample the march (default 60);
//                           with YUKI_BENCH_FULL=1 sampling runs to completion
//   YUKI_BENCH_FULL         "1" = wait for full recognition completion
//   YUKI_BENCH_DEBUG        "1" = ?ocrDebug=1 + capture per-stage [ocr-page]
//   YUKI_BENCH_MAX_S        hard ceiling for the whole run (default 1800)
//   YUKI_BENCH_LABEL        label for the output file
//   YUKI_BENCH_OUT          output JSON path (default /tmp/ocr-bench/<label>.json)
//
// Warm-profile isolation: before loading the app the harness opens the SAME
// origin (a cheap /ocr-models/vocab.txt document) and clears ONLY the result
// stores (books/manga/mangaPages/mangaOcr), preserving the model cache
// (ocrModels) and localStorage (the cached execution provider). It first
// checks indexedDB.databases(): on a fresh COLD profile the "yuki" DB does
// not exist yet and must NOT be opened (opening it would create an empty v1
// DB whose upgrade guard skips creating the stores — corrupting the run).
// The vocab navigation is not counted as a model download: the request sets
// are cleared right before the app loads.
//
// Example:
//   YUKI_BENCH_ZIP=/path/vol.zip YUKI_BENCH_POOL=1 YUKI_BENCH_THREADS=6 \
//     YUKI_BENCH_LABEL=kny-p1x6-cold YUKI_BENCH_FULL=1 \
//     pnpm tsx tests/ocr-bench.ts

import {
  mkdirSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1422";
const ZIP = process.env.YUKI_BENCH_ZIP;
const DIR = process.env.YUKI_BENCH_DIR;
const POOL = process.env.YUKI_BENCH_POOL;
const THREADS = process.env.YUKI_BENCH_THREADS;
const EP = process.env.YUKI_BENCH_EP;
const PROFILE_DIR = process.env.YUKI_BENCH_PROFILE_DIR;
const COLLECT_S = Number(process.env.YUKI_BENCH_COLLECT_S ?? 60);
const FULL = process.env.YUKI_BENCH_FULL === "1";
const DEBUG = process.env.YUKI_BENCH_DEBUG === "1";
const MAX_S = Number(process.env.YUKI_BENCH_MAX_S ?? 1800);
const LABEL = process.env.YUKI_BENCH_LABEL ?? "run";
const OUT = process.env.YUKI_BENCH_OUT ?? `/tmp/ocr-bench/${LABEL}.json`;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

function resolveInputs(): string[] {
  if (ZIP) return [ZIP];
  if (DIR) {
    const files = readdirSync(DIR)
      .filter((name) => IMAGE_EXT.test(name))
      .map((name) => join(DIR, name));
    if (files.length === 0) throw new Error(`no images in ${DIR}`);
    return files;
  }
  throw new Error("set YUKI_BENCH_ZIP or YUKI_BENCH_DIR");
}

interface Snapshot {
  mangaBooks: { id: string; pageCount: number }[];
  detected: number;
  recognized: number;
  total: number;
}

/** Storage-truth snapshot: every manga book + aggregate OCR progress, read
    straight from IndexedDB (the same stores the app writes). The mangaOcr
    keys and records come from ONE readonly transaction so an in-flight write
    can never misalign the two arrays. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "yuki"))
      return { mangaBooks: [], detected: 0, recognized: 0, total: 0 };
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const books = await new Promise<
      { id: string; format?: string; pageCount?: number }[]
    >((resolve, reject) => {
      const r = db.transaction("books").objectStore("books").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const mangaBooks = books
      .filter((b) => b.format === "manga")
      .map((b) => ({ id: b.id, pageCount: b.pageCount ?? 0 }));
    const ids = new Set(mangaBooks.map((b) => b.id));
    // One transaction → keys[i] always matches records[i].
    const tx = db.transaction("mangaOcr");
    const store = tx.objectStore("mangaOcr");
    const [keys, records] = await Promise.all([
      new Promise<string[]>((resolve, reject) => {
        const r = store.getAllKeys();
        r.onsuccess = () => resolve(r.result as string[]);
        r.onerror = () => reject(r.error);
      }),
      new Promise<{ partial?: boolean }[]>((resolve, reject) => {
        const r = store.getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
    ]);
    db.close();
    let detected = 0;
    let recognized = 0;
    keys.forEach((key, i) => {
      const bookId = key.slice(0, key.lastIndexOf("/"));
      if (!ids.has(bookId)) return;
      detected += 1;
      if (records[i] && !records[i]!.partial) recognized += 1;
    });
    const total = mangaBooks.reduce((sum, b) => sum + b.pageCount, 0);
    return { mangaBooks, detected, recognized, total };
  });
}

/** Clear ONLY the result stores on an existing DB; never create the DB on a
    cold profile, never touch ocrModels (model cache) or localStorage. */
async function clearResults(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "yuki")) return "cold-no-db";
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const targets = ["books", "manga", "mangaPages", "mangaOcr"].filter((s) =>
      db.objectStoreNames.contains(s),
    );
    if (targets.length > 0) {
      const tx = db.transaction(targets, "readwrite");
      for (const s of targets) tx.objectStore(s).clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    db.close();
    return `cleared:${targets.join(",")}`;
  });
}

/** Dump every OCR record for the manga books, keyed by NUMERIC page index
    (the random book UUID is stripped so hashes match across runs), sorted by
    page. Keys+records come from one transaction. */
async function dumpOcr(
  page: Page,
): Promise<{ page: number; partial?: boolean; blocks: unknown }[]> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "yuki")) return [];
    const req = indexedDB.open("yuki");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const books = await new Promise<{ id: string; format?: string }[]>(
      (resolve, reject) => {
        const r = db.transaction("books").objectStore("books").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      },
    );
    const ids = new Set(
      books.filter((b) => b.format === "manga").map((b) => b.id),
    );
    const tx = db.transaction("mangaOcr");
    const store = tx.objectStore("mangaOcr");
    const [keys, records] = await Promise.all([
      new Promise<string[]>((resolve, reject) => {
        const r = store.getAllKeys();
        r.onsuccess = () => resolve(r.result as string[]);
        r.onerror = () => reject(r.error);
      }),
      new Promise<{ partial?: boolean; blocks: unknown }[]>(
        (resolve, reject) => {
          const r = store.getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        },
      ),
    ]);
    db.close();
    const out: { page: number; partial?: boolean; blocks: unknown }[] = [];
    keys.forEach((key, i) => {
      const bookId = key.slice(0, key.lastIndexOf("/"));
      if (!ids.has(bookId)) return;
      const page = Number(key.slice(key.lastIndexOf("/") + 1));
      if (!Number.isFinite(page)) return;
      out.push({ page, partial: records[i]?.partial, blocks: records[i]?.blocks });
    });
    out.sort((a, b) => a.page - b.page);
    return out;
  });
}

interface OcrPageRow {
  page: number;
  total: number;
  detect: number;
  blocks: number;
  crop: number;
  enc: number;
  dec: number;
}

function sha(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

async function main(): Promise<void> {
  const inputs = resolveInputs();
  const params = new URLSearchParams();
  if (POOL) params.set("ocrPool", POOL);
  if (THREADS) params.set("ocrThreads", THREADS);
  if (DEBUG) params.set("ocrDebug", "1");
  const url = `${BASE}/?${params.toString()}`;

  const userDataDir =
    PROFILE_DIR ?? mkdtempSync(join(tmpdir(), "yuki-bench-cold-"));
  const profileKind = PROFILE_DIR ? "persistent" : "fresh";

  const browser = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    args: [
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--ignore-gpu-blocklist",
    ],
  });

  if (EP && EP !== "auto") {
    await browser.addInitScript((ep: string) => {
      try {
        localStorage.setItem("yuki-ocr-ep", ep);
      } catch {
        /* storage unavailable */
      }
    }, EP);
  }

  const page = browser.pages()[0] ?? (await browser.newPage());

  const consoleLines: { t: number; text: string }[] = [];
  const ocrRows: OcrPageRow[] = [];
  const modelReqs = new Set<string>();
  const runtimeReqs = new Set<string>();
  let workerReadyAt: number | null = null;
  let firstError: string | null = null;
  const t0 = Date.now();
  const stamp = () => Date.now() - t0;
  page.on("console", (msg) => {
    const text = msg.text();
    const t = stamp();
    if (text.includes("[ocr")) consoleLines.push({ t, text });
    if (text.includes("worker ready") && workerReadyAt === null)
      workerReadyAt = t;
    if (msg.type() === "error" && firstError === null) firstError = text;
    const m = text.match(
      /\[ocr-page\] #(\d+) total (\d+)ms \| detect (\d+) \| blocks (\d+) in \d+ \(crop (\d+), enc (\d+), dec (\d+)\)/,
    );
    if (m)
      ocrRows.push({
        page: +m[1]!,
        total: +m[2]!,
        detect: +m[3]!,
        blocks: +m[4]!,
        crop: +m[5]!,
        enc: +m[6]!,
        dec: +m[7]!,
      });
  });
  page.on("pageerror", (err) => {
    if (firstError === null) firstError = `pageerror: ${err.message}`;
  });
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/ocr-models/")) modelReqs.add(u.split("?")[0]!);
    else if (u.includes("ort-wasm") || u.includes("jsep"))
      runtimeReqs.add(u.split("?")[0]!);
  });

  // Warm-profile isolation: clear result stores on the same origin BEFORE the
  // app loads (guarded so a cold profile is never corrupted).
  await page.goto(`${BASE}/ocr-models/vocab.txt`);
  const clearOutcome = await clearResults(page);
  // The vocab fetch above must not count as a model download.
  modelReqs.clear();
  runtimeReqs.clear();

  const caps = await page.goto(url).then(async () =>
    page.evaluate(() => ({
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      cores: navigator.hardwareConcurrency ?? 0,
      gpu: !!(navigator as Navigator & { gpu?: unknown }).gpu,
    })),
  );

  console.log(
    `[bench] ${LABEL} | ${ZIP ? "zip" : "dir"} (${inputs.length} files) | pool=${POOL ?? "default"} threads=${THREADS ?? "default"} ep=${EP ?? "auto"} profile=${profileKind} clear=${clearOutcome}`,
  );
  console.log(
    `[bench] caps: isolated=${caps.crossOriginIsolated} cores=${caps.cores} gpu=${caps.gpu}`,
  );

  await page.waitForTimeout(800);
  const tImport = stamp();
  await page.setInputFiles('input[accept*=".zip"]', inputs);
  console.log(`[bench] +${(tImport / 1000).toFixed(1)}s import sent`);

  let snap = await snapshot(page);
  const deadline = Date.now() + MAX_S * 1000;
  while (snap.mangaBooks.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(500);
    snap = await snapshot(page);
  }
  if (snap.mangaBooks.length === 0) throw new Error("no manga book imported");
  const tileAt = stamp();
  console.log(
    `[bench] +${(tileAt / 1000).toFixed(1)}s tile present | total pages=${snap.total} books=${snap.mangaBooks.length}`,
  );

  const milestones: Record<string, number | null> = {
    workerReady: null,
    detectFirst: null,
    detectComplete: null,
    recognizedFirst: null,
    fullComplete: null,
  };
  const samples: { t: number; detected: number; recognized: number }[] = [];
  let collectStart: number | null = null;

  while (Date.now() < deadline) {
    snap = await snapshot(page);
    const now = stamp();
    samples.push({
      t: now,
      detected: snap.detected,
      recognized: snap.recognized,
    });

    if (milestones.workerReady === null && workerReadyAt !== null)
      milestones.workerReady = workerReadyAt;
    if (milestones.detectFirst === null && snap.detected > 0)
      milestones.detectFirst = now;
    if (
      milestones.detectComplete === null &&
      snap.total > 0 &&
      snap.detected >= snap.total
    ) {
      milestones.detectComplete = now;
      console.log(
        `[bench] +${(now / 1000).toFixed(1)}s detect COMPLETE (gate clear)`,
      );
    }
    if (milestones.recognizedFirst === null && snap.recognized > 0)
      milestones.recognizedFirst = now;
    if (collectStart === null && milestones.detectComplete !== null)
      collectStart = now;
    if (
      milestones.fullComplete === null &&
      snap.total > 0 &&
      snap.recognized >= snap.total
    ) {
      milestones.fullComplete = now;
      console.log(`[bench] +${(now / 1000).toFixed(1)}s FULL completion`);
    }

    const fullDone = milestones.fullComplete !== null;
    if (FULL) {
      if (fullDone) break;
    } else if (collectStart !== null && now >= collectStart + COLLECT_S * 1000)
      break;
    await page.waitForTimeout(500);
  }

  if (FULL && milestones.fullComplete === null) {
    await browser.close();
    throw new Error(
      `OCR did not complete before ${MAX_S}s: ${snap.recognized}/${snap.total}`,
    );
  }

  // Throughput over the collect window (detect-complete → end/full).
  let pagesPerMin: number | null = null;
  let windowRecognized = 0;
  let windowS = 0;
  if (collectStart !== null) {
    const inWin = samples.filter((s) => s.t >= collectStart!);
    if (inWin.length >= 2) {
      const first = inWin[0]!;
      const last = inWin[inWin.length - 1]!;
      windowS = (last.t - first.t) / 1000;
      windowRecognized = last.recognized - first.recognized;
      if (windowS > 0) pagesPerMin = (windowRecognized / windowS) * 60;
    }
  }

  const epUsed = await page
    .evaluate(() => localStorage.getItem("yuki-ocr-ep"))
    .catch(() => null);

  // Exact-output dump for equivalence hashing (page-index keyed, so the
  // random book UUID never contaminates the hash).
  mkdirSync(dirname(OUT), { recursive: true });
  const dump = await dumpOcr(page);
  const fullHash = sha(dump);
  const textOnly = dump.map((r) => [
    r.page,
    (r.blocks as { lines?: string[] }[])?.map((b) => b.lines?.join("") ?? ""),
  ]);
  const textHash = sha(textOnly);
  const perPageBlocks = dump.map((r) => [
    r.page,
    Array.isArray(r.blocks) ? (r.blocks as unknown[]).length : 0,
  ]);
  writeFileSync(`${OUT}.ocr.json`, JSON.stringify(dump));

  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  const result = {
    label: LABEL,
    fixture: ZIP ?? DIR,
    fixtureKind: ZIP ? "zip" : "dir",
    inputFiles: inputs.length,
    pool: POOL ?? "default",
    threads: THREADS ?? "default",
    epRequested: EP ?? "auto",
    epUsed,
    profile: profileKind,
    profileDir: userDataDir,
    clearOutcome,
    caps,
    totalPages: snap.total,
    books: snap.mangaBooks,
    milestonesMs: milestones,
    importStartedMs: tImport,
    importToTileMs: tileAt - tImport,
    workerReadyMs: milestones.workerReady,
    detectGateMs:
      milestones.detectComplete !== null && milestones.detectFirst !== null
        ? milestones.detectComplete - milestones.detectFirst
        : null,
    importToDetectCompleteMs:
      milestones.detectComplete === null
        ? null
        : milestones.detectComplete - tImport,
    importToFullMs:
      milestones.fullComplete === null ? null : milestones.fullComplete - tImport,
    harnessStartToFullMs: milestones.fullComplete,
    collectWindowS: +windowS.toFixed(1),
    windowRecognized,
    pagesPerMin: pagesPerMin !== null ? +pagesPerMin.toFixed(1) : null,
    finalDetected: snap.detected,
    finalRecognized: snap.recognized,
    modelRequests: [...modelReqs],
    modelRequestCount: modelReqs.size,
    runtimeRequests: [...runtimeReqs],
    fullHash,
    textHash,
    ocrDumpFile: `${OUT}.ocr.json`,
    perPageBlocks,
    firstError,
    ocrPageRows: ocrRows.length,
    perPageAvgMs: ocrRows.length
      ? {
          total: +avg(ocrRows.map((r) => r.total)).toFixed(0),
          detect: +avg(ocrRows.map((r) => r.detect)).toFixed(0),
          blocks: +avg(ocrRows.map((r) => r.blocks)).toFixed(1),
          crop: +avg(ocrRows.map((r) => r.crop)).toFixed(0),
          enc: +avg(ocrRows.map((r) => r.enc)).toFixed(0),
          dec: +avg(ocrRows.map((r) => r.dec)).toFixed(0),
        }
      : null,
    consoleLines: consoleLines.slice(0, 80),
  };

  writeFileSync(OUT, JSON.stringify(result, null, 2));

  console.log(`[bench] worker ready: ${fmt(milestones.workerReady)}`);
  console.log(
    `[bench] detect gate: ${fmt(milestones.detectComplete)} (gate span ${fmt(result.detectGateMs)})`,
  );
  console.log(
    `[bench] march: ${windowRecognized} pages in ${windowS.toFixed(0)}s → ${pagesPerMin !== null ? pagesPerMin.toFixed(1) : "?"} pages/min`,
  );
  if (result.perPageAvgMs)
    console.log(
      `[bench] per page avg: total ${result.perPageAvgMs.total}ms | detect ${result.perPageAvgMs.detect} | blocks ${result.perPageAvgMs.blocks} | crop ${result.perPageAvgMs.crop} enc ${result.perPageAvgMs.enc} dec ${result.perPageAvgMs.dec}`,
    );
  if (FULL)
    console.log(`[bench] full completion: ${fmt(milestones.fullComplete)}`);
  console.log(
    `[bench] model requests: ${modelReqs.size} | runtime requests: ${runtimeReqs.size}`,
  );
  console.log(
    `[bench] fullHash: ${fullHash.slice(0, 16)} textHash: ${textHash.slice(0, 16)}`,
  );
  if (firstError)
    console.log(`[bench] FIRST ERROR: ${firstError.slice(0, 200)}`);
  console.log(`[bench] ep used: ${epUsed} | wrote ${OUT}`);

  await browser.close();
}

function fmt(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

await main();
