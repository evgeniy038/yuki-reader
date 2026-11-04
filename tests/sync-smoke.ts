// Two-device sync, end to end in real Chrome: two browser profiles are two
// devices (separate IndexedDB + localStorage); Yandex Disk — OAuth, the REST
// API and its upload/download hosts — is emulated by request interception
// over one in-memory folder, so no account, no network. Books are built on
// the fly. Covered: the Mac connects (PKCE redirect, a fresh vault, the
// recovery key shown once); the phone connects and opens the library with
// that key; a reading position, a pin and a setting travel Mac → phone;
// reading on the phone travels back; the phone's reading time reaches the
// Mac's statistics without double counting; manga kept in the cloud comes
// down as a tile; manga that never went up comes straight from the open Mac
// over WebRTC; an offline phone catches up; and nothing in the cloud is
// readable.
// Needs a dev server started with a provider id, e.g.:
//   VITE_YANDEX_CLIENT_ID=smoke pnpm dev --port 1480
//   YUKI_TEST_BASE=http://localhost:1480 pnpm tsx tests/sync-smoke.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { chromium, type BrowserContext, type Page, type Route } from "playwright-core";
import { exitToShelf } from "./import-open.ts";

const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

// --- Books ------------------------------------------------------------------
function epub(title: string, sentence: string): Uint8Array {
  const body = Array.from({ length: 2000 }, (_, i) => `<p>${sentence}${i}。</p>`).join("");
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`),
    "content.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
    "c1.xhtml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`),
  });
}

// A mokuro volume: page images plus a sidecar with a box on every page, so
// the in-app OCR has nothing to do. Returns the files to import.
async function mangaVolume(root: string, title: string, colors: string[], width: number, height: number): Promise<string[]> {
  const folder = join(root, title);
  mkdirSync(folder);
  const pages: string[] = [];
  for (const [i, color] of colors.entries()) {
    const path = join(folder, `p${i + 1}.png`);
    await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(path);
    pages.push(path);
  }
  const sidecar = join(folder, `${title} 第01巻.mokuro`);
  writeFileSync(sidecar, JSON.stringify({
    version: "0.2.1",
    title,
    volume: `${title} 第01巻`,
    pages: pages.map((_, i) => ({
      img_path: `p${i + 1}.png`, img_width: width, img_height: height,
      blocks: [{ box: [20, 20, 120, 160], vertical: true, font_size: 24, lines: ["テスト"] }],
    })),
  }));
  return [...pages, sidecar];
}

// --- The fake Yandex (one folder for every device) ----------------------------
const files = new Map<string, Uint8Array>();
const dirs = new Set<string>([""]);
const hrefs = new Map<string, string>();
let hrefSeq = 0;
let tokenExchanges = 0;
/** The cloud is unreachable (the app itself stays cached and usable). */
let cloudDown = false;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
};
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });

async function yandex(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (cloudDown) return route.abort("internetdisconnected");
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (url.pathname === "/authorize") {
    const back = `${BASE}/?code=code-${hrefSeq++}&state=${url.searchParams.get("state")}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(request.postData() ?? "");
    if (!form.get("code_verifier") || form.has("client_secret")) return json(route, 400, { error: "invalid_request" });
    tokenExchanges += 1;
    return json(route, 200, { access_token: "tok", refresh_token: "ref", expires_in: 31_536_000 });
  }
  if (url.hostname.includes("uploader") || url.hostname.includes("downloader")) {
    const path = hrefs.get(url.pathname);
    if (path === undefined) return json(route, 404, {});
    if (request.method() === "PUT") {
      files.set(path, new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0)));
      return route.fulfill({ status: 201, headers: cors });
    }
    const file = files.get(path);
    return file ? route.fulfill({ status: 200, headers: cors, body: Buffer.from(file) }) : json(route, 404, {});
  }
  if (request.headers().authorization !== "OAuth tok") return json(route, 401, { error: "UnauthorizedError" });
  const path = (url.searchParams.get("path") ?? "").replace(/^app:\//, "");
  if (url.pathname.endsWith("/upload")) {
    const id = `/upload/${hrefSeq++}`;
    hrefs.set(id, path);
    return json(route, 200, { href: `https://uploader1j.disk.yandex.net${id}`, method: "PUT" });
  }
  if (url.pathname.endsWith("/download")) {
    if (!files.has(path)) return json(route, 404, { error: "DiskNotFoundError" });
    const id = `/download/${hrefSeq++}`;
    hrefs.set(id, path);
    return json(route, 200, { href: `https://downloader.disk.yandex.ru${id}` });
  }
  if (request.method() === "PUT") {
    if (dirs.has(path)) return json(route, 409, {});
    dirs.add(path);
    return json(route, 201, {});
  }
  if (request.method() === "DELETE") return json(route, files.delete(path) ? 204 : 404, {});
  if (!dirs.has(path)) return json(route, 404, { error: "DiskNotFoundError" });
  const child = (p: string) => p !== path && p.startsWith(path === "" ? "" : `${path}/`) && !p.slice(path.length + 1).includes("/");
  const items = [
    ...[...dirs].filter(child).map((d) => ({ name: d.slice(path.length + 1), type: "dir" })),
    ...[...files].filter(([f]) => child(f)).map(([f, b]) => ({ name: f.slice(path.length + 1), type: "file", md5: String(b.length) + f, modified: String(b[b.length - 1]), size: b.length })),
  ];
  return json(route, 200, { _embedded: { items, total: items.length } });
}

async function device(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  for (const host of ["https://oauth.yandex.ru/**", "https://cloud-api.yandex.net/**", "https://*.disk.yandex.net/**", "https://*.disk.yandex.ru/**"]) {
    await context.route(host, yandex);
  }
  const page = await context.newPage();
  await page.goto(BASE);
  return { context, page };
}

// --- Helpers ------------------------------------------------------------------
async function read(page: Page, turns: number, linger: number, title = "台所の本"): Promise<void> {
  // By title: books arriving from the other device share the shelf now.
  await page.locator("[data-book-id]").filter({ hasText: title }).first().click();
  await page.waitForSelector(".book-content", { timeout: 30_000 });
  await page.waitForTimeout(800);
  for (let i = 0; i < turns; i += 1) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(linger); // dwell → bookmark; past the 10s warmup → stats
  await exitToShelf(page);
}

const progressOf = (page: Page, title: string) =>
  page.evaluate(async (title) => {
    const storage = await import("/src/core/storage.ts");
    return (await storage.loadAllBooks()).find((book) => book.title === title)?.progress ?? -1;
  }, title);

async function openSync(page: Page): Promise<void> {
  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector("text=Sync", { timeout: 10_000 });
}

async function syncNow(page: Page): Promise<void> {
  await openSync(page);
  const button = page.locator("[data-sync-now]");
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  await page.waitForFunction(() => document.querySelector("[data-sync-now]")?.getAttribute("data-loading") === null, null, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

async function main(): Promise<void> {
  if (!(await fetch(BASE).then((r) => r.ok, () => false))) throw new Error(`nothing answers on ${BASE}`);
  const dir = mkdtempSync(join(tmpdir(), "yuki-sync-"));
  const kitchen = join(dir, "kitchen.epub");
  const other = join(dir, "other.epub");
  writeFileSync(kitchen, epub("台所の本", "わたしがこの世でいちばん好きな場所は台所だと思う"));
  writeFileSync(other, epub("変な家の本", "その家には奇妙な間取りがあった"));
  // Plain host candidates: both "devices" are one machine, and headless
  // Chrome can't resolve the mDNS names it would hide them behind.
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  try {
    // --- Mac: a library, a reading position, a pin, then connect. ---------
    const mac = await device(browser);
    await mac.page.setInputFiles('input[accept*="epub"]', kitchen);
    await mac.page.waitForSelector("[data-book-id]", { timeout: 30_000 });
    await read(mac.page, 6, 13_000);
    const macProgress = await progressOf(mac.page, "台所の本");
    check(macProgress > 0, `the Mac has a reading position (${(macProgress * 100).toFixed(1)}%)`);
    await mac.page.locator("[data-book-favorite]").first().hover();
    await mac.page.locator("[data-book-favorite]").first().click();
    await openSync(mac.page);
    await mac.page.locator('[data-sync-connect="yandex"]').click();
    await mac.page.waitForSelector("[data-sync-new-key]", { timeout: 30_000 });
    const recoveryKey = (await mac.page.locator("[data-sync-key]").textContent())?.trim() ?? "";
    check(/^[0-9A-Z*~$=]{4}(-[0-9A-Z*~$=]{3,4}){6}$/.test(recoveryKey), "the Mac shows a recovery key once");
    check(tokenExchanges === 1, "the code was exchanged with PKCE, no secret");
    check(!new URL(mac.page.url()).search.includes("code="), "the code is gone from the address bar");
    await mac.page.getByRole("switch", { name: "I saved the key" }).click();
    await mac.page.locator("[data-sync-key-done]").click();
    await mac.page.waitForSelector('[data-sync-status="ok"]', { timeout: 30_000 });
    await syncNow(mac.page);
    check([...files.keys()].some((f) => f.startsWith("devices/") && f.endsWith("/state.bin")), "the Mac's state is in the cloud");
    const cloudText = [...files.values()].map((b) => Buffer.from(b).toString("latin1")).join("");
    check(!cloudText.includes(Buffer.from("台所の本").toString("latin1")), "no title is readable in the cloud");

    // --- Phone: the same book imported on its own, plus another one. ------
    const phone = await device(browser);
    await phone.page.setInputFiles('input[accept*="epub"]', [kitchen, other]);
    await phone.page.waitForFunction(() => document.querySelectorAll("[data-book-id]").length >= 2, null, { timeout: 30_000 });
    await openSync(phone.page);
    await phone.page.locator('[data-sync-connect="yandex"]').click();
    await phone.page.waitForSelector("[data-sync-unlock-input]", { timeout: 30_000 });
    await phone.page.locator("[data-sync-unlock-input]").fill(recoveryKey.toLowerCase());
    await phone.page.locator("[data-sync-unlock]").click();
    await phone.page.waitForSelector('[data-sync-status="ok"]', { timeout: 30_000 });
    await syncNow(phone.page);
    const phoneProgress = await progressOf(phone.page, "台所の本");
    check(Math.abs(phoneProgress - macProgress) < 1e-9, `the Mac's position reached the phone (${(phoneProgress * 100).toFixed(1)}%)`);
    const pinned = await phone.page.evaluate(async () => {
      const storage = await import("/src/core/storage.ts");
      return (await storage.loadAllBooks()).find((book) => book.title === "台所の本")?.favorite === true;
    });
    check(pinned, "the Mac's pin reached the phone");
    check((await phone.page.locator("[data-sync-devices] li").count()) === 2, "the phone lists two devices");

    // --- A setting travels Mac → phone. ----------------------------------
    await mac.page.goto(`${BASE}/#/settings`);
    await mac.page.getByRole("radio", { name: "Sepia" }).click();
    await syncNow(mac.page);
    await syncNow(phone.page);
    const theme = await phone.page.evaluate(() => JSON.parse(localStorage.getItem("yuki:reading") ?? "{}").theme);
    check(theme === "sepia", "the Mac's reading theme reached the phone");

    // --- A book only the phone had arrives on the Mac by itself. -----------
    check(
      [...files.keys()].filter((f) => /^books\/[^/]+\/[0-9a-f]{32}\/manifest\.bin$/.test(f)).length === 2,
      "each book's files went up once, by whoever had it first",
    );
    const arrived = await mac.page.evaluate(async () => {
      const storage = await import("/src/core/storage.ts");
      const book = (await storage.loadShelfBooks()).find((b) => b.title === "変な家の本");
      return book ? ((await storage.loadBookContent(book.id))?.chapters[0]?.html.includes("奇妙な間取り") ?? false) : false;
    });
    check(arrived, "a book only the phone had arrived on the Mac with its text");
    const sealedText = [...files.values()].map((b) => Buffer.from(b).toString("latin1")).join("");
    check(!sealedText.includes(Buffer.from("奇妙な間取り").toString("latin1")), "the book's text is unreadable in the cloud");

    // --- Manga stays home unless kept in the cloud; then it's a tile there. --
    await mac.page.goto(`${BASE}/#/`);
    await mac.page.setInputFiles('input[accept*=".mokuro"]', await mangaVolume(dir, "テスト漫画", ["#c33", "#36c"], 300, 420));
    const series = mac.page.locator("[data-book-id]").filter({ hasText: "テスト漫画" }).first();
    await series.waitFor({ timeout: 30_000 });
    await syncNow(mac.page);
    const manifests = () => [...files.keys()].filter((f) => /^books\/[^/]+\/[0-9a-f]{32}\/manifest\.bin$/.test(f)).length;
    check(manifests() === 2, "a manga volume doesn't go up on its own");
    await mac.page.goto(`${BASE}/#/`);
    await mac.page.locator("[data-book-id]").filter({ hasText: "テスト漫画" }).first().click();
    await mac.page.getByRole("button", { name: "series actions" }).click();
    await mac.page.locator('[data-keep-in-cloud="off"]').click();
    await syncNow(mac.page);
    check(manifests() === 3, "\"Keep in the cloud\" sends the volume up");
    await syncNow(phone.page);
    await phone.page.goto(`${BASE}/#/`);
    const tile = phone.page.locator("[data-cloud-book]");
    await tile.first().waitFor({ timeout: 15_000 }).catch(() => {});
    check((await tile.count()) === 1, "the phone shows the volume as a cloud tile");
    await tile.first().click();
    await phone.page.waitForSelector("[data-manga-current] img", { timeout: 30_000 }).catch(() => {});
    check((await phone.page.locator("[data-manga-current] img").count()) >= 1, "a tap downloads the volume and opens it");
    await phone.page.goto(`${BASE}/#/`);
    check((await phone.page.locator("[data-cloud-book]").count()) === 0, "…and it's a book on the shelf now, not a tile");

    // --- Never in the cloud: straight from the open Mac, over WebRTC. -------
    await mac.page.goto(`${BASE}/#/`);
    await mac.page.setInputFiles('input[accept*=".mokuro"]', await mangaVolume(dir, "ちょくせつ", ["#2a7", "#a72", "#72a"], 320, 450));
    await mac.page.locator("[data-book-id]").filter({ hasText: "ちょくせつ" }).first().waitFor({ timeout: 30_000 });
    const packsBefore = manifests();
    await syncNow(mac.page); // the Mac stays open on this page and answers
    check(manifests() === packsBefore, "a volume not kept in the cloud stays off it");
    await syncNow(phone.page);
    await phone.page.goto(`${BASE}/#/`);
    const fromMac = phone.page.locator('[data-cloud-from="device"]');
    await fromMac.first().waitFor({ timeout: 15_000 }).catch(() => {});
    check((await fromMac.count()) === 1, "the phone offers the Mac's volume as a tile from that device");
    await fromMac.first().click();
    await phone.page.waitForSelector("[data-manga-current] img", { timeout: 60_000 }).catch(() => {});
    const shown = await phone.page
      .locator("[data-manga-current] img")
      .first()
      .evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth, () => 0))
      .catch(() => 0);
    check(shown === 320, "a tap brings the volume straight from the Mac and opens it");
    const arrivedPages = await phone.page.evaluate(async () => {
      const storage = await import("/src/core/storage.ts");
      const book = (await storage.loadAllBooks()).find((b) => b.title.includes("ちょくせつ"));
      return book ? ((await storage.loadManga(book.id))?.pages.length ?? 0) : -1;
    });
    check(arrivedPages === 3, `every page came over (${arrivedPages}/3)`);
    check(manifests() === packsBefore, "…and not a byte of it went through the cloud");
    await phone.page.waitForTimeout(1_000);
    const signals = [...files].filter(([path]) => path.startsWith("signal/"));
    check(!signals.some(([path]) => path.endsWith(".offer.bin")), "the doorbell is taken down afterwards");
    check(
      signals.every(([, bytes]) => !Buffer.from(bytes).toString("latin1").includes("a=fingerprint")),
      "the doorbell (addresses, keys) is unreadable in the cloud",
    );

    // --- Reading on the phone travels back; its time counts on the Mac. ----
    await phone.page.goto(`${BASE}/#/`);
    await read(phone.page, 6, 13_000);
    const phoneAfter = await progressOf(phone.page, "台所の本");
    check(phoneAfter > macProgress, "the phone read further");
    await syncNow(phone.page);
    await syncNow(mac.page);
    check(Math.abs((await progressOf(mac.page, "台所の本")) - phoneAfter) < 1e-9, "the phone's position reached the Mac");
    const totals = await mac.page.evaluate(async () => {
      // No named helpers in here: esbuild would wrap them in __name().
      const local = await (await import("/src/core/storage.ts")).loadStats();
      const merged = await (await import("/src/core/sync/stats.ts")).loadMergedStats();
      return {
        local: local.reduce((s: number, d: { timeMs: number }) => s + d.timeMs, 0),
        merged: merged.reduce((s: number, d: { timeMs: number }) => s + d.timeMs, 0),
      };
    });
    check(totals.local > 0 && totals.merged > totals.local, `the Mac's statistics add the phone's reading (${totals.local} → ${totals.merged} ms)`);
    const again = await mac.page.evaluate(async () => {
      const merged = await (await import("/src/core/sync/stats.ts")).loadMergedStats();
      return merged.reduce((s, d) => s + d.timeMs, 0);
    });
    await syncNow(mac.page);
    const afterResync = await mac.page.evaluate(async () => {
      const merged = await (await import("/src/core/sync/stats.ts")).loadMergedStats();
      return merged.reduce((s, d) => s + d.timeMs, 0);
    });
    check(again === afterResync, "syncing again doesn't count anything twice");

    // --- Offline: the phone keeps reading, then catches up. ----------------
    cloudDown = true;
    await phone.page.goto(`${BASE}/#/`);
    await read(phone.page, 4, 4_000);
    const offlineProgress = await progressOf(phone.page, "台所の本");
    check(offlineProgress > phoneAfter, "reading goes on while the cloud is unreachable");
    await openSync(phone.page);
    await phone.page.locator("[data-sync-now]").click();
    await phone.page.waitForSelector('[data-sync-status="error"]', { timeout: 30_000 }).catch(() => {});
    check((await phone.page.locator('[data-sync-status="error"]').count()) === 1, "an unreachable cloud shows as a calm sync error");
    cloudDown = false;
    await syncNow(phone.page);
    await syncNow(mac.page);
    check(Math.abs((await progressOf(mac.page, "台所の本")) - offlineProgress) < 1e-9, "the offline reading reached the Mac once back online");

    // --- The Mac closed: the tile says where to open yuki. -----------------
    await mac.page.goto(`${BASE}/#/`);
    await mac.page.setInputFiles('input[accept*=".mokuro"]', await mangaVolume(dir, "とじた", ["#555", "#999"], 300, 420));
    await mac.page.locator("[data-book-id]").filter({ hasText: "とじた" }).first().waitFor({ timeout: 30_000 });
    await syncNow(mac.page);
    await mac.context.close();
    await syncNow(phone.page);
    await phone.page.goto(`${BASE}/#/`);
    await phone.page.locator('[data-cloud-from="device"]').first().click();
    const waiting = phone.page.locator("[data-cloud-waiting]");
    await waiting.waitFor({ timeout: 15_000 }).catch(() => {});
    check(((await waiting.textContent().catch(() => "")) ?? "").includes("Open yuki on"), "with the Mac closed, the tile asks to open yuki there");

    await phone.context.close();
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nsync smoke: all good");
}

await main();
