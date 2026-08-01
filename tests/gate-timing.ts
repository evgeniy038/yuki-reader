// TEMPORARY gate-timing probe v2: detect-stage gate duration, decomposed.
// Imports kaguya zip, opens the series page, polls [data-ocr-gated] every
// second, and captures [ocr]/status console lines to separate model
// download+init from the pure detect pass.
//   YUKI_TEST_MANGA_DIR=... pnpm tsx tests/gate-timing.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { requireEnv } from "./env.ts";

const MANGA_DIR = requireEnv("YUKI_TEST_MANGA_DIR");
const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";

const zipName = readdirSync(join(MANGA_DIR, "kaguya")).find((n) => /\.zip$/i.test(n));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);
page.on("console", (m) => {
  const text = m.text();
  if (text.includes("[ocr]") || text.includes("error")) console.log(`  +${stamp()}s ${text.slice(0, 140)}`);
});
await page.goto(BASE);
await page.waitForTimeout(1200);

await page.setInputFiles('input[accept*=".mokuro"]', join(MANGA_DIR, "kaguya", zipName!));
console.log(`+${stamp()}s import sent`);

await page.locator("[data-book-id]", { hasText: "かぐや様" }).first().click({ timeout: 60_000 });
console.log(`+${stamp()}s series page opened`);

let gateSeenAt: number | null = null;
for (;;) {
  const gated = await page.evaluate(() => !!document.querySelector("[data-ocr-gated]"));
  const now = Date.now();
  if (gated && gateSeenAt === null) {
    gateSeenAt = now;
    console.log(`+${stamp()}s gate VISIBLE`);
  }
  if (!gated && gateSeenAt !== null) {
    console.log(`+${stamp()}s gate GONE — detect stage done in ${((now - gateSeenAt) / 1000).toFixed(1)}s of gating`);
    break;
  }
  if (now - t0 > 600_000) {
    console.log("TIMEOUT");
    break;
  }
  await page.waitForTimeout(1000);
}
await browser.close();
