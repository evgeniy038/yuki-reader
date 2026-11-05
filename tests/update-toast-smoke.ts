// Exercise the actual update card with the service-worker hook set to ready.
// No waiting service worker or deployed version is needed for layout checks.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.YUKI_TEST_BASE ?? "http://localhost:1480";
const out = "artifacts/local/update-toast";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    const context = await browser.newContext({ viewport, locale: "ru-RU" });
    await context.route(/virtual:pwa-register/, (route) => route.fulfill({
      contentType: "text/javascript",
      body: `export function useRegisterSW() {
        return {needRefresh: [true], updateServiceWorker: async () => { document.body.dataset.updateApplied = "true"; }};
      }`,
    }));
    const page = await context.newPage();
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("[data-update-ready]").waitFor({ timeout: 30_000 });
    await page.locator("nav").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const check = async () => {
      // Wait out the entry animation by checking its final geometry.
      await page.waitForFunction(() => {
        const card = document.querySelector("[data-update-ready]");
        return card && card.getAnimations().every((animation) => animation.playState === "finished");
      });
      const card = await page.locator("[data-update-ready]").boundingBox();
      const dock = await page.locator("nav").boundingBox();
      assert.ok(card && dock);
      assert.ok(card.y > viewport.height / 2, "the update card sits at the bottom");
      assert.ok(card.x >= 8 && card.x + card.width <= viewport.width - 8, "the card fits the phone");
      assert.ok(card.y + card.height <= dock.y, "the dock remains clear");
      assert.equal(await page.locator("[data-sync-glow], .sync-glow").count(), 0);
      const button = page.locator("[data-update-ready] button");
      assert.ok(await button.isVisible());
      assert.ok(await button.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), "the update button is clickable");
      return card;
    };
    await check();
    await page.screenshot({ path: `${out}/${viewport.width}-shelf.png` });
    await page.evaluate(async () => {
      const ocr = await import("/src/core/ocr/progress.ts");
      ocr.status.models = { loaded: 10, total: 100 };
      ocr.emitStatus();
    });
    await page.locator('[data-ocr-status][aria-hidden="false"]').waitFor();
    const card = await check();
    const ocr = await page.locator('[data-ocr-status][aria-hidden="false"]').boundingBox();
    assert.ok(ocr && ocr.y + ocr.height <= card.y, "recognition and update controls do not overlap");
    await page.screenshot({ path: `${out}/${viewport.width}-with-ocr.png` });
    await page.locator('[data-view="settings"]').click();
    await page.waitForURL(/settings/);
    await check();
    await page.locator("[data-update-ready] button").click();
    assert.equal(await page.locator("body").getAttribute("data-update-applied"), "true");
    console.log(`✓ update card, dock, OCR and settings at ${viewport.width}px`);
    await context.close();
  }
} finally { await browser.close(); }
