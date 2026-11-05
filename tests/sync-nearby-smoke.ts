// Real Worker/DO signaling, WebRTC, app UI and IndexedDB in two isolated
// profiles. No provider or vault is configured on either device.
// Worker: wrangler dev -c worker/wrangler.jsonc --port 1481 --var ALLOWED_ORIGINS:http://localhost:1480
// App: VITE_PAIRING_URL=ws://localhost:1481 pnpm dev --port 1480
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { fake, yandex } from "./sync-smoke-cloud.ts";

const base = process.env.YUKI_TEST_BASE ?? "http://localhost:1480";
const cloudOnMac = process.env.YUKI_TEST_PAIRED_CLOUD === "1";
const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
const errors: string[] = [];
let providerRequests = 0;
let ocrRequests = 0;
async function device(phone = false) {
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, locale: "en" });
  await context.route(/https:\/\/.*(dropbox|yandex)\./, (route) => { providerRequests++; return route.abort(); });
  if (cloudOnMac && !phone) {
    for (const host of ["https://oauth.yandex.ru/**", "https://cloud-api.yandex.net/**", "https://*.disk.yandex.net/**", "https://*.disk.yandex.ru/**"]) await context.route(host, yandex);
  }
  await context.addInitScript(() => {
    const connections = new Set<RTCPeerConnection>();
    const Original = RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(options?: RTCConfiguration) { super(options); connections.add(this); }
    };
    window.addEventListener("yuki-test:drop-peer", () => { for (const pc of connections) pc.close(); });
  });
  await context.route("**/ocr-models/**", (route) => { ocrRequests++; return route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/#/settings`);
  return { page, context };
}
async function connected(page: Page) {
  await page.waitForSelector('[data-peer-connected="true"]', { timeout: 40_000 });
}
async function hasNovel(page: Page) {
  await until(() => page.evaluate(async () => (await (await import("/src/core/storage.ts")).loadShelfBooks()).some((book) => book.title === "Code-paired novel")));
}
async function until(check: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

try {
  const mac = await device();
  const phone = await device(true);
  await mac.page.evaluate(async () => (await import("/tests/sync-nearby-fixture.ts")).seed());
  await mac.page.reload();
  if (cloudOnMac) {
    await mac.page.locator('[data-sync-connect="yandex"]').click();
    await mac.page.locator("[data-sync-new-key]").waitFor({ timeout: 30_000 });
    await mac.page.getByRole("switch", { name: "I saved the key" }).click();
    await mac.page.locator("[data-sync-key-done]").click();
    await until(() => mac.page.evaluate(async () => !(await import("/src/components/sync/sync-controller.ts")).getView().syncing));
    fake.down = true;
  }
  await phone.page.evaluate(async () => (await import("/tests/sync-nearby-fixture.ts")).instrument());
  await mac.page.locator("[data-pair-create]").click();
  const code = await mac.page.locator("[data-pair-code]").innerText();
  await phone.page.locator("[data-pair-input]").fill(code);
  const started = Date.now();
  await phone.page.locator("[data-pair-join]").click();
  await mac.page.locator("[data-pair-confirm]").waitFor({ timeout: 30_000 });
  assert.equal(await phone.page.evaluate(async () => (await (await import("/src/core/storage.ts")).loadShelfBooks()).length), 0, "approval happens before any library data is shared");
  await mac.page.locator("[data-pair-confirm]").click();
  await Promise.all([connected(mac.page), connected(phone.page)]);
  await hasNovel(phone.page);
  console.log(`✓ code pairing + novel received in ${Date.now() - started} ms, no account`);
  const received = await phone.page.evaluate(async () => {
    const storage = await import("/src/core/storage.ts");
    const store = (await import("/src/core/sync/store.ts")).syncStore;
    const book = (await storage.loadShelfBooks()).find((book) => book.title === "Code-paired novel");
    return { progress: book?.progress, favorite: book?.favorite, session: await store.session(), vault: await store.vault() };
  });
  assert.equal(received.progress, 0.42);
  assert.equal(received.favorite, true);
  assert.equal(received.session, undefined);
  assert.equal(received.vault, undefined);
  await phone.page.evaluate(async () => (await import("/tests/sync-nearby-fixture.ts")).readOnPhone());
  await until(() => mac.page.evaluate(async () => (await (await import("/src/core/storage.ts")).loadShelfBooks()).find((book) => book.id === "novel")?.progress === 0.77));
  await until(() => mac.page.evaluate(async () => (await (await import("/src/core/sync/stats.ts")).loadMergedStats()).reduce((sum, day) => sum + day.timeMs, 0) === 180_000));
  console.log("✓ progress, pin and statistics travel both ways without double counting");
  // A navigation reload loses every connection; the remembered pairing
  // must reconnect without another code and keep the remote catalog.
  await phone.page.reload();
  await connected(phone.page);
  await phone.page.evaluate(async () => (await import("/tests/sync-nearby-fixture.ts")).instrument());
  await until(() => phone.page.evaluate(async () => (await import("/src/components/sync/sync-controller.ts")).getView().cloud.some((item) => item.desc.title === "Wi-Fi volume")));
  const transferStart = Date.now();
  await phone.page.evaluate(async () => {
    const sync = await import("/src/components/sync/sync-controller.ts");
    const item = sync.getView().cloud.find((item) => item.desc.title === "Wi-Fi volume");
    if (!item) throw new Error("Volume tile missing");
    await (await import("/src/components/sync/sync-cloud.ts")).download(item.key);
    await (await import("/tests/sync-nearby-fixture.ts")).verifyVolume();
  });
  console.log(`✓ remembered connection, 32 MiB volume byte-for-byte in ${Date.now() - transferStart} ms`);
  const retry = await phone.page.evaluate(async () => {
    const sync = await import("/src/components/sync/sync-controller.ts");
    const cloud = await import("/src/components/sync/sync-cloud.ts");
    const storage = await import("/src/core/storage.ts");
    const fixture = await import("/tests/sync-nearby-fixture.ts");
    const volume = (await storage.loadShelfBooks()).find((book) => book.title === "Wi-Fi volume");
    if (!volume) throw new Error("Volume missing");
    await cloud.removeDownload(volume.id);
    const item = sync.getView().cloud.find((item) => item.desc.title === "Wi-Fi volume");
    if (!item) throw new Error("Volume tile missing after eviction");
    let dropped = false;
    const unsubscribe = sync.subscribe(() => {
      if (!dropped && (sync.getView().downloads[item.key] ?? 0) >= 0.125) {
        dropped = true;
        fixture.dropConnection();
      }
    });
    const start = performance.now();
    try { await cloud.download(item.key); await fixture.verifyVolume(); }
    finally { unsubscribe(); }
    return { dropped, ms: performance.now() - start, copies: (await storage.loadShelfBooks()).filter((book) => book.title === "Wi-Fi volume").length };
  });
  assert.equal(retry.dropped, true);
  assert.equal(retry.copies, 1);
  console.log(`✓ dropped a live transfer after 4 MiB, reconnected and retried cleanly in ${Math.round(retry.ms)} ms`);
  await phone.page.evaluate(async () => {
    const storage = await import("/src/core/storage.ts");
    const book = (await storage.loadShelfBooks()).find((book) => book.title === "Wi-Fi volume");
    const manga = book && await storage.loadManga(book.id);
    if (!manga) throw new Error("Volume missing");
    await storage.putMangaRecord({ ...manga, pages: manga.pages.map(({ blocks: _blocks, ...page }) => page) });
    (await import("/src/components/sync/sync-ready.ts")).forgetReadiness(manga.id);
    (await import("/src/components/sync/sync-controller.ts")).requestSync(0);
  });
  await until(() => phone.page.evaluate(async () => {
    const storage = await import("/src/core/storage.ts");
    const book = (await storage.loadShelfBooks()).find((book) => book.title === "Wi-Fi volume");
    if (!book) return false;
    const ocr = await storage.loadMangaOcr(book.id);
    return ocr.size === 32 && [...ocr.values()].every((record) => record.blocks[0]?.lines[0] === "本文");
  }));
  console.log("✓ missing text for an existing volume arrives separately, with no OCR model download");
  if (cloudOnMac) {
    await mac.page.evaluate(async () => (await import("/src/components/sync/sync-controller.ts")).disconnect());
    await Promise.all([connected(mac.page), connected(phone.page)]);
    await phone.page.reload();
    await connected(phone.page);
    console.log("✓ unavailable cloud and cloud disconnection do not break the remembered Wi-Fi pairing");
  }
  const duplicate = await mac.context.newPage();
  await duplicate.goto(`${base}/#/settings`);
  await until(() => duplicate.evaluate(async () => {
    const locks = await navigator.locks.query();
    return locks.held?.filter((lock) => lock.name?.startsWith("yuki-peer:")).length === 1 && locks.pending?.some((lock) => lock.name?.startsWith("yuki-peer:")) === true;
  }));
  await connected(mac.page);
  await mac.page.close();
  mac.page = duplicate;
  await Promise.all([connected(mac.page), connected(phone.page)]);
  console.log("✓ a second tab waits for the connection owner and takes over when the first closes");
  mkdirSync("artifacts/local/nearby-sync", { recursive: true });
  await phone.page.locator("[data-pair-create]").evaluate((element) => element.scrollIntoView({ block: "center" }));
  await phone.page.screenshot({ path: "artifacts/local/nearby-sync/phone.png" });
  assert.equal(providerRequests, 0, "no Dropbox/Yandex traffic");
  assert.equal(ocrRequests, 0, "transferred manga is not recognized again");
  assert.deepEqual(errors, []);
  console.log("sync-nearby smoke: all checks passed");
} finally { await browser.close(); }
