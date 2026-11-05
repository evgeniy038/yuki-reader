// How much memory on-device OCR takes on a phone — the page plus the GPU
// process, read from the OS (phys_footprint, what iOS kills a page by), not
// guessed. iOS charges a page for its GPU memory too and kills it past
// roughly 2 GB ("a problem repeatedly occurred", then a reload loop); OCR
// resumes at every start, so a pool that doesn't fit kills the app again
// seconds after each reload. That was the crash recorded on an iPhone: a
// 281-page volume synced from the Mac without text, two OCR workers.
// Phases, on an emulated phone (touch, 430×932 @3x): the app at rest; a
// volume without text arrives and OCR starts on its own; reading it while
// OCR runs; a fresh start of the app with the queue unfinished.
// Needs a dev server and the models in public/ocr-models (macOS: `footprint`):
//   YUKI_TEST_BASE=http://localhost:1480 pnpm tsx tests/ocr-memory-bench.ts
// Knobs: PAGES (synthetic text pages, default 120), OCR_VOL (a real volume —
// zip/cbz/epub — instead), OCR_POOL (force a pool size: 2 is what an iPhone
// ran before), OCR_SECS (OCR phase length), BUDGET_MB (default 2048).
// Chrome on a Mac stands in for WebKit on the phone: compare runs, and keep
// the peak well under the budget — the exit code fails a run above it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";

const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
const PAGES = Number(process.env.PAGES ?? 120);
const OCR_SECS = Number(process.env.OCR_SECS ?? 60);
const BUDGET_MB = Number(process.env.BUDGET_MB ?? 2048);
const query = process.env.OCR_POOL ? `?ocrPool=${process.env.OCR_POOL}` : "";

/** A page with two vertical speech bubbles and a block of art. */
async function textPage(i: number): Promise<Uint8Array> {
  const column = (x: number, y: number, text: string) =>
    `<text x="${x}" y="${y}" font-size="40" font-family="Hiragino Sans, sans-serif" writing-mode="tb">${text}</text>`;
  const bubble = (cx: number, cy: number, n: number) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="220" ry="330" fill="#fff" stroke="#000" stroke-width="4"/>` +
    Array.from({ length: 5 }, (_, c) => column(cx + 120 - c * 56, cy - 230, `${n}頁の${c}行目を読む`)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1700"><rect width="1200" height="1700" fill="#fff"/>${bubble(900, 400, i)}${bubble(330, 1250, i + 1)}<rect x="60" y="80" width="460" height="700" fill="#666"/><rect x="700" y="950" width="440" height="680" fill="#444"/></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer());
}

/** Renderer (the page and its workers) and GPU process of the browser running on `profile`. */
function pids(profile: string): { renderer: number; gpu: number } {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="]).toString().trim().split("\n");
  const procs = rows.map((row) => {
    const [pid, ppid, rss, ...command] = row.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command: command.join(" ") };
  });
  const root = procs.find((p) => p.command.includes(`--user-data-dir=${profile}`) && !p.command.includes("--type="));
  if (!root) return { renderer: 0, gpu: 0 };
  const family = new Set([root.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (family.has(p.ppid) && !family.has(p.pid)) (family.add(p.pid), (grew = true));
  }
  const mine = procs.filter((p) => family.has(p.pid));
  const renderer = mine.filter((p) => p.command.includes("--type=renderer")).sort((a, b) => b.rss - a.rss)[0];
  return { renderer: renderer?.pid ?? 0, gpu: mine.find((p) => p.command.includes("--type=gpu-process"))?.pid ?? 0 };
}

/** phys_footprint in MB, per pid. */
function footprints(list: number[]): Map<number, number> {
  const out = new Map<number, number>();
  const live = list.filter((pid) => pid > 0);
  if (live.length === 0) return out;
  try {
    const text = execFileSync("footprint", live.flatMap((pid) => ["-p", String(pid)])).toString();
    for (const match of text.matchAll(/\[(\d+)\]: .*?Footprint: ([\d.]+) (KB|MB|GB)/g)) {
      const value = Number(match[2]);
      out.set(Number(match[1]), match[3] === "GB" ? value * 1024 : match[3] === "KB" ? value / 1024 : value);
    }
  } catch {
    // a process exited between ps and footprint — skip this sample
  }
  return out;
}

async function ocrCounts(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("yuki");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains("mangaOcr")) return "0 scanned, 0 read";
    const all = await new Promise<{ partial?: boolean }[]>((resolve) => {
      const req = db.transaction("mangaOcr").objectStore("mangaOcr").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return `${all.length} scanned, ${all.filter((r) => !r.partial).length} read`;
  }).catch(() => "?");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-ocrmem-"));
  const profile = join(dir, "profile");
  let peaks = { renderer: 0, gpu: 0, sum: 0 };
  let worst = 0;
  let sampling = false;
  const sampler = setInterval(() => {
    if (!sampling) return;
    const { renderer, gpu } = pids(profile);
    const fp = footprints([renderer, gpu]);
    const r = fp.get(renderer) ?? 0;
    const g = fp.get(gpu) ?? 0;
    peaks = { renderer: Math.max(peaks.renderer, r), gpu: Math.max(peaks.gpu, g), sum: Math.max(peaks.sum, r + g) };
  }, 500);
  // Every "start" is a fresh browser on the same profile — a phone's
  // crash-reload doesn't keep the old page's memory either.
  const open = async () => {
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      viewport: { width: 430, height: 932 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${BASE}/${query}`);
    return { context, page };
  };
  const phase = async (label: string, page: Page, run: () => Promise<void>) => {
    peaks = { renderer: 0, gpu: 0, sum: 0 };
    sampling = true;
    const started = Date.now();
    await run();
    sampling = false;
    worst = Math.max(worst, peaks.sum);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `  ${label.padEnd(30)} page ${peaks.renderer.toFixed(0).padStart(5)} + gpu ${peaks.gpu.toFixed(0).padStart(5)} = peak ${peaks.sum.toFixed(0).padStart(5)} MB  (${secs} s, ${await ocrCounts(page)})`,
    );
  };
  try {
    let volume = process.env.OCR_VOL;
    if (!volume) {
      const entries: Record<string, Uint8Array> = {};
      for (let i = 1; i <= PAGES; i += 1) entries[`p${String(i).padStart(3, "0")}.jpg`] = await textPage(i);
      volume = join(dir, "文字の漫画 第01巻.zip");
      writeFileSync(volume, zipSync(entries, { level: 0 }));
    }
    let app = await open();
    const touch = await app.page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    console.log(`volume: ${process.env.OCR_VOL ?? `${PAGES} synthetic text pages`}; phone (coarse pointer: ${touch}), pool ${process.env.OCR_POOL ?? "the app's own"}`);
    await app.page.waitForSelector('input[accept*=".mokuro"]', { state: "attached" });
    await phase("app at rest", app.page, () => app.page.waitForTimeout(8_000));
    await phase("volume arrives, OCR starts", app.page, async () => {
      await app.page.setInputFiles('input[accept*=".mokuro"]', [volume]);
      await app.page.waitForTimeout(OCR_SECS * 1000);
    });
    await phase("reading while OCR runs", app.page, async () => {
      await app.page.locator("[data-book-id]").first().click();
      if (!(await app.page.locator("[data-manga-page]").isVisible({ timeout: 3_000 }).catch(() => false))) {
        await app.page.locator("[data-book-id]").first().click();
      }
      await app.page.locator("[data-manga-page]").waitFor({ timeout: 60_000 });
      for (let i = 0; i < 20; i += 1) {
        await app.page.keyboard.press("ArrowLeft");
        await app.page.waitForTimeout(1_000);
      }
    });
    await app.context.close();
    app = await open();
    await phase("app start, OCR unfinished", app.page, () => app.page.waitForTimeout(30_000));
    await app.context.close();
  } finally {
    clearInterval(sampler);
    rmSync(dir, { recursive: true, force: true });
  }
  const verdict = worst <= BUDGET_MB ? "within" : "OVER";
  console.log(`worst phase: ${worst.toFixed(0)} MB — ${verdict} the ${BUDGET_MB} MB a phone page may use`);
  if (worst > BUDGET_MB) process.exitCode = 1;
}

await main();
