// Built site + the real production pairing service. YUKI_TEST_BUILT=1 serves
// dist under the production origin in isolated test profiles, before release.
// Without that flag this checks the actually deployed site.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { epub } from "./sync-smoke-books.ts";

const base = "https://yukireader.app";
const dir = mkdtempSync(join(tmpdir(), "yuki-pair-production-"));
const file = join(dir, "pairing.epub");
const title = "Account-free Wi-Fi verification";
const phrase = "This book arrived over a direct connection";
writeFileSync(file, epub(title, phrase));
const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
const errors: string[] = [];
let providers = 0;
try {
  const contexts = await Promise.all([browser.newContext({ locale: "en" }), browser.newContext({ locale: "ru", viewport: { width: 390, height: 844 } })]);
  for (const context of contexts) {
    if (process.env.YUKI_TEST_BUILT === "1") {
      await context.route(`${base}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        await route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : `.${path}`), headers: {
          "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin",
        } });
      });
    }
    await context.route(/https:\/\/.*(dropbox|yandex)\./, (route) => { providers++; return route.abort(); });
  }
  const [mac, phone] = await Promise.all(contexts.map((context) => context.newPage()));
  assert.ok(mac && phone);
  for (const page of [mac, phone]) page.on("pageerror", (error) => errors.push(error.message));
  await Promise.all([mac.goto(base), phone.goto(`${base}/#/settings`)]);
  await mac.setInputFiles('input[accept*="epub"]', file);
  await mac.locator("[data-book-id]").filter({ hasText: title }).waitFor({ timeout: 30_000 });
  await mac.goto(`${base}/#/settings`);
  await mac.locator("[data-pair-create]").click();
  await phone.locator("[data-pair-input]").fill(await mac.locator("[data-pair-code]").innerText());
  await phone.locator("[data-pair-join]").click();
  await mac.locator("[data-pair-confirm]").waitFor({ timeout: 40_000 });
  await mac.locator("[data-pair-confirm]").click();
  await Promise.all([mac.waitForSelector('[data-peer-connected="true"]', { timeout: 40_000 }), phone.waitForSelector('[data-peer-connected="true"]', { timeout: 40_000 })]);
  mkdirSync("artifacts/local/nearby-sync", { recursive: true });
  await phone.locator("[data-pair-create]").evaluate((element) => element.scrollIntoView({ block: "center" }));
  await phone.screenshot({ path: "artifacts/local/nearby-sync/production-phone.png" });
  await phone.goto(`${base}/#/`);
  const book = phone.locator("[data-book-id]").filter({ hasText: title });
  await book.waitFor({ timeout: 40_000 });
  assert.equal(await book.count(), 1);
  await book.click();
  await phone.locator(".book-content").waitFor({ timeout: 30_000 });
  assert.ok((await phone.locator(".book-content").innerText()).includes(phrase));
  assert.equal(providers, 0);
  assert.deepEqual(errors, []);
  console.log(`✓ ${process.env.YUKI_TEST_BUILT === "1" ? "built" : "deployed"} site pairs through pair.yukireader.app, transfers and opens a real EPUB; no cloud account or browser errors`);
} finally { await browser.close(); rmSync(dir, { recursive: true, force: true }); }
