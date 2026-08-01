// TEMPORARY march-timing probe: recognition march throughput in-app.
// Launches with ?ocrDebug=1, imports kaguya, waits out the detect gate,
// then collects [ocr-page] lines for N seconds and averages the per-stage
// split (crop / enc / dec) and pages/min.
//   YUKI_TEST_MANGA_DIR=... pnpm tsx tests/march-timing.ts [seconds]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { requireEnv } from "./env.ts";

const MANGA_DIR = requireEnv("YUKI_TEST_MANGA_DIR");
const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
const COLLECT_S = Number(process.argv[2] ?? 90);

const zipName = readdirSync(join(MANGA_DIR, "kaguya")).find((n) => /\.zip$/i.test(n));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();

interface Row { total: number; detect: number; blocks: number; blocksMs: number; crop: number; enc: number; dec: number }
const rows: Row[] = [];
page.on("console", (m) => {
  const text = m.text();
  // [ocr-page] #12 total 2345ms | detect 96 | blocks 14 in 2210 (crop 140, enc 1520, dec 550)
  const match = text.match(
    /\[ocr-page\] #(\d+) total (\d+)ms \| detect (\d+) \| blocks (\d+) in (\d+) \(crop (\d+), enc (\d+), dec (\d+)\)/,
  );
  if (match) {
    rows.push({
      total: +match[2]!, detect: +match[3]!, blocks: +match[4]!,
      blocksMs: +match[5]!, crop: +match[6]!, enc: +match[7]!, dec: +match[8]!,
    });
  }
});

await page.goto(`${BASE}/?ocrDebug=1`);
await page.waitForTimeout(1200);
const t0 = Date.now();
await page.setInputFiles('input[accept*=".mokuro"]', join(MANGA_DIR, "kaguya", zipName!));

// Wait until the march is underway (first ocr-page log), then collect.
await page.waitForTimeout(5000);
while (rows.length === 0 && Date.now() - t0 < 300_000) await page.waitForTimeout(2000);
console.log(`march started at +${((Date.now() - t0) / 1000).toFixed(0)}s; collecting ${COLLECT_S}s`);
const marchStart = Date.now();
while (Date.now() - marchStart < COLLECT_S * 1000) await page.waitForTimeout(2000);

if (rows.length === 0) {
  console.log("no [ocr-page] lines captured — march never ran?");
} else {
  const n = rows.length;
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const spanS = (Date.now() - marchStart) / 1000;
  console.log(`pages: ${n} in ${spanS.toFixed(0)}s → ${((n / spanS) * 60).toFixed(1)} pages/min`);
  console.log(
    `per page: total ${(sum((r) => r.total) / n).toFixed(0)}ms | detect ${(sum((r) => r.detect) / n).toFixed(0)} | ` +
      `blocks ${(sum((r) => r.blocks) / n).toFixed(1)} | crop ${(sum((r) => r.crop) / n).toFixed(0)} | ` +
      `enc ${(sum((r) => r.enc) / n).toFixed(0)} | dec ${(sum((r) => r.dec) / n).toFixed(0)}`,
  );
}
await browser.close();
