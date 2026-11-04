// Shared scaffold of the speed benchmark (tests/perf-bench.ts and
// tests/perf-bench-ocr.ts): browser sessions on throwaway profiles (cleaned
// after each scenario), fixture lookup, and the reader drivers — open a
// book, turn pages, reload for startup — timed with tests/perf-probes.ts.
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  chromium,
  webkit,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { requireEnv } from "./env.ts";
import {
  epubSignature,
  installProbes,
  lastKeyAt,
  longTasks,
  median,
  memory,
  now,
  percentile,
  round,
  until,
} from "./perf-probes.ts";

export const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
export const TURNS = 30;
export const WEBKIT = process.env.YUKI_BENCH_ENGINE === "webkit";
export const results: Record<string, unknown> = { base: BASE, at: new Date().toISOString() };

export interface Session {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession | null;
}

export const contexts: BrowserContext[] = [];

export async function session(profile: string): Promise<Session> {
  const options = { viewport: { width: 1280, height: 800 }, locale: "en-US" };
  const context = WEBKIT
    ? await webkit.launchPersistentContext(profile, {
        ...options,
        executablePath:
          process.env.YUKI_WEBKIT_PATH ??
          join(homedir(), "Library/Caches/ms-playwright/webkit-2370/pw_run.sh"),
      })
    : await chromium.launchPersistentContext(profile, {
        ...options,
        channel: "chrome",
        headless: true,
        args: ["--enable-blink-features=ForceEagerMeasureMemory"],
      });
  contexts.push(context);
  await installProbes(context);
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));
  const cdp = WEBKIT ? null : await context.newCDPSession(page);
  return { context, page, cdp };
}

// Profiles are big (a library of scans, the model cache): every temp dir
// goes away after its scenario, even when the scenario throws.
export const temps: string[] = [];
export const tempProfile = () => {
  const dir = mkdtempSync(join(tmpdir(), "yuki-bench-"));
  temps.push(dir);
  return dir;
};
export const cleanTemps = async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => {});
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
};
export const realFiles = (dir: string, re: RegExp) =>
  [...new Set(readdirSync(dir).filter((n) => re.test(n)).map((n) => realpathSync(join(dir, n))))]
    .filter((p) => statSync(p).isFile())
    .sort();
export const bookInput = 'input[accept*=".epub"]';

export async function goShelf(page: Page, url = BASE): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("main") !== null);
  await page.waitForTimeout(800);
}

/** Click the first tile whose text holds `text`, stamped in-page. */
export async function clickTile(page: Page, text: string): Promise<number> {
  return page.evaluate((text) => {
    const tile = [...document.querySelectorAll<HTMLElement>("[data-book-id]")].find((el) =>
      (el.textContent ?? "").includes(text),
    );
    if (!tile) throw new Error(`no tile "${text}"`);
    const at = performance.now();
    tile.click();
    return at;
  }, text);
}

/** TURNS forward page turns (ArrowLeft: vertical ja and manga are RTL). */
export async function turnPages(page: Page, kind: "epub" | "manga"): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < TURNS; i++) {
    const before =
      kind === "epub"
        ? await epubSignature(page)
        : await page.evaluate(
            () => document.querySelector("[data-manga-page]")?.getAttribute("data-manga-page") ?? "",
          );
    await page.keyboard.press("ArrowLeft");
    const hit =
      kind === "epub"
        ? await until(page, "epubTurned", before, 15_000)
        : await page
            .waitForFunction(
              (prev) => {
                const set = document.querySelector("[data-manga-page]");
                const imgs = set ? [...set.querySelectorAll("img")] : [];
                if (!set || set.getAttribute("data-manga-page") === prev) return false;
                if (!imgs.every((img) => img.complete && img.naturalWidth > 0)) return false;
                window.__perf.hit = performance.now();
                return true;
              },
              before,
              { polling: "raf", timeout: 15_000 },
            )
            .then(() => page.evaluate(() => window.__perf.hit));
    out.push(hit - (await lastKeyAt(page)));
    await page.waitForTimeout(120);
  }
  return out;
}

export const turnStats = (turns: number[]) => ({
  median: round(median(turns)),
  p95: round(percentile(turns, 95)),
  max: round(Math.max(...turns)),
});

export async function openEpub(page: Page, text: string): Promise<Record<string, number>> {
  const t0 = await clickTile(page, text);
  const open = await until(page, "epubOpen");
  await page.evaluate(() => document.fonts.ready);
  const settled = await now(page);
  const blocked = await longTasks(page, t0, settled);
  return { openMs: round(open - t0), settledMs: round(settled - t0), maxTaskMs: blocked.max };
}

export async function backToShelf(page: Page, tiles: number): Promise<void> {
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await until(page, "tiles", tiles, 30_000);
  await page.waitForTimeout(400);
}

export async function startup(s: Session, tiles: number, runs = 3): Promise<Record<string, number | null>> {
  const shelf: number[] = [];
  for (let i = 0; i < runs; i++) {
    await s.page.reload();
    shelf.push(await until(s.page, "tiles", tiles, 120_000));
  }
  await s.page.waitForTimeout(1500);
  const mem = await memory(s.page, s.cdp);
  return { shelfMs: round(median(shelf)), heapMB: mem.heapMB, totalMB: mem.totalMB };
}

export async function mangaFixtures() {
  const dir = requireEnv("YUKI_TEST_MANGA_DIR");
  const folder = join(dir, "推しの子 第02巻", "推しの子 第02巻");
  const kaguya = realFiles(join(dir, "kaguya"), /第01巻\.zip$/)[0]!;
  const kaguyaHd = realFiles(join(dir, "kaguya"), /\.cbz$/)[0]!;
  const kimetsu = realFiles(join(dir, "kimetsunoyaiba"), /\.zip$/)[0]!;
  const yani = realFiles(join(dir, "スーパーの裏でヤニ吸うふたり"), /1巻.*\.epub$/)[0]!;
  const folderFiles = [
    ...realFiles(folder, /\.jpe?g$/i),
    join(dir, "推しの子 第02巻", "推しの子 第02巻.mokuro"),
  ];
  return { folderFiles, kaguya, kaguyaHd, kimetsu, yani };
}
