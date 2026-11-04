// How much memory sync takes on a heavy library — the page's renderer RSS,
// read from the OS, not guessed. A phone kills a page that grows too big
// (iOS Safari: "a problem repeatedly occurred", then a reload loop), so a
// round must stay close to what the shelf itself needs. Phases: the shelf at
// rest; the first round (catalog + novel uploads); a manga volume going up
// ("Keep in the cloud"); and a fresh start of the app on a synced library.
// Needs the sync dev server (tests/README.md), e.g.:
//   YUKI_TEST_BASE=http://localhost:1480 pnpm tsx tests/sync-memory-bench.ts
// Knobs: NOVELS (count), NOVEL_MB (images per novel), PAGES (manga pages, ~1 MB each).
// Against the dev server the numbers carry dev-mode overhead (unbundled
// modules) and swing ±50 MB run to run: compare phases, not absolutes —
// "app start, synced library" should sit at "app start, sync off".

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { files, yandex } from "./sync-smoke-cloud.ts";

const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
const NOVELS = Number(process.env.NOVELS ?? 4);
const NOVEL_MB = Number(process.env.NOVEL_MB ?? 40);
const PAGES = Number(process.env.PAGES ?? 120);

function novel(title: string): Uint8Array {
  const images: Record<string, Uint8Array> = {};
  const items: string[] = [];
  for (let i = 0; i < NOVEL_MB / 4; i += 1) {
    images[`img${i}.jpg`] = randomBytes(4 * 1024 * 1024);
    items.push(`<item id="i${i}" href="img${i}.jpg" media-type="image/jpeg"/>`);
  }
  const body = Array.from({ length: 3000 }, (_, i) => `<p>${title}の${i}行目。</p>`).join("");
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`),
    "content.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>${items.join("")}</manifest><spine><itemref idref="c1"/></spine></package>`),
    "c1.xhtml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`),
    ...images,
  }, { level: 0 });
}

/** The biggest renderer under the browser process, in MB. */
function rendererMb(root: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="]).toString().trim().split("\n");
  const procs = rows.map((row) => {
    const [pid, ppid, rss, ...command] = row.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command: command.join(" ") };
  });
  const family = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (family.has(p.ppid) && !family.has(p.pid)) (family.add(p.pid), (grew = true));
  }
  const renderers = procs.filter((p) => family.has(p.pid) && p.command.includes("--type=renderer"));
  return Math.max(0, ...renderers.map((p) => p.rss)) / 1024;
}

async function idle(page: Page, quietMs: number, maxMs: number): Promise<void> {
  // Until the cloud stops changing for a while (uploads done) or time's up.
  const started = Date.now();
  let last = -1;
  let since = Date.now();
  while (Date.now() - started < maxMs) {
    const size = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    if (size !== last) (last = size), (since = Date.now());
    if (Date.now() - since > quietMs) return;
    await page.waitForTimeout(500);
  }
}

/** The browser process running on `profile` (renderers hang below it). */
function browserPid(profile: string): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,command="]).toString().split("\n");
  const row = rows.find((r) => r.includes(`--user-data-dir=${profile}`) && !r.includes("--type="));
  return Number(row?.trim().split(/\s+/)[0] ?? 0);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-mem-"));
  const profile = join(dir, "profile");
  let root = 0;
  let peak = 0;
  const sampler = setInterval(() => {
    if (root) peak = Math.max(peak, rendererMb(root));
  }, 200);
  // Every "start" is a fresh browser on the same profile — a reload keeps
  // the old renderer and its memory, a phone's crash-reload doesn't.
  const open = async (): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: 430, height: 932 } });
    for (const host of ["https://oauth.yandex.ru/**", "https://cloud-api.yandex.net/**", "https://*.disk.yandex.net/**", "https://*.disk.yandex.ru/**"]) {
      await context.route(host, yandex);
    }
    root = browserPid(profile);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(BASE);
    return { page, close: async () => ((root = 0), await context.close()) };
  };
  const phase = async (label: string, run: () => Promise<void>) => {
    peak = 0;
    const started = Date.now();
    await run();
    console.log(`  ${label.padEnd(34)} peak ${peak.toFixed(0).padStart(5)} MB  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  };
  try {
    const novels = Array.from({ length: NOVELS }, (_, i) => {
      const path = join(dir, `novel${i}.epub`);
      writeFileSync(path, novel(`重い本${i}`));
      return path;
    });
    const scans = join(dir, "manga");
    mkdirSync(scans);
    const pages: string[] = [];
    for (let i = 1; i <= PAGES; i += 1) {
      const path = join(scans, `p${i}.jpg`);
      await sharp({ create: { width: 1200, height: 1700, channels: 3, background: "#888", noise: { type: "gaussian", mean: 128, sigma: 40 } } })
        .jpeg({ quality: 88 })
        .toFile(path);
      pages.push(path);
    }
    const sidecar = join(scans, "重い漫画 第01巻.mokuro");
    writeFileSync(sidecar, JSON.stringify({
      version: "0.2.1", title: "重い漫画", volume: "重い漫画 第01巻",
      pages: pages.map((_, i) => ({ img_path: `p${i + 1}.jpg`, img_width: 1200, img_height: 1700, blocks: [{ box: [20, 20, 120, 160], vertical: true, font_size: 24, lines: ["重"] }] })),
    }));
    console.log(`library: ${NOVELS} novels × ${NOVEL_MB} MB, a ${PAGES}-page volume`);

    let app = await open();
    await app.page.setInputFiles('input[accept*="epub"]', novels);
    await app.page.waitForFunction((n) => document.querySelectorAll("[data-book-id]").length >= n, NOVELS, { timeout: 300_000 });
    await app.page.setInputFiles('input[accept*=".mokuro"]', [...pages, sidecar]);
    await app.page.locator("[data-book-id]").filter({ hasText: "重い漫画" }).first().waitFor({ timeout: 300_000 });
    // Stored, not just on screen: every book and every page.
    await app.page.waitForFunction(async ({ books, pages }) => {
      const storage = await import("/src/core/storage.ts");
      const all = await storage.loadAllBooks();
      const manga = all.find((b) => b.format === "manga");
      const stored = manga ? await storage.loadMangaPageBlob(manga.id, pages - 1) : undefined;
      return all.length === books && stored !== undefined;
    }, { books: NOVELS + 1, pages: PAGES }, { timeout: 300_000, polling: 1_000 });
    await app.close();

    app = await open();
    await phase("app start, sync off", () => app.page.waitForTimeout(20_000));
    await phase("first sync (catalog, novels up)", async () => {
      await app.page.goto(`${BASE}/#/settings`);
      await app.page.locator('[data-sync-connect="yandex"]').click();
      await app.page.waitForSelector("[data-sync-new-key]", { timeout: 60_000 });
      await app.page.getByRole("switch", { name: "I saved the key" }).click();
      await app.page.locator("[data-sync-key-done]").click();
      await idle(app.page, 12_000, 240_000);
    });
    await app.close();

    app = await open();
    await phase("manga volume up (keep in cloud)", async () => {
      await app.page.waitForSelector("[data-book-id]", { timeout: 60_000 });
      await app.page.locator("[data-book-id]").filter({ hasText: "重い漫画" }).first().click();
      await app.page.getByRole("button", { name: "series actions" }).click();
      await app.page.locator('[data-keep-in-cloud="off"]').click();
      await app.page.goto(`${BASE}/#/settings`);
      await app.page.locator("[data-sync-now]").click();
      await idle(app.page, 12_000, 240_000);
    });
    await app.close();

    app = await open();
    await phase("app start, synced library", () => app.page.waitForTimeout(20_000));
    await app.close();
  } finally {
    clearInterval(sampler);
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
