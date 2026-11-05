// Real WebRTC between isolated Chrome profiles; the cloud only carries SDP.
// YUKI_TEST_BASE=http://localhost:1480 pnpm tsx tests/sync-peer-smoke.ts
import { strict as assert } from "node:assert";
import { chromium, type Page } from "playwright-core";

const base = process.env.YUKI_TEST_BASE ?? "http://localhost:1480";
const files = new Map<string, { bytes: Buffer; rev: number }>();
let revision = 0;
let latency = Number(process.env.LATENCY_MS ?? 0);
let failAnswers = 0;
let failOffers = 0;
let failOfferReads = 0;
let reads = 0;
let unreachable: Page | null = null;
let blockedAnswerRead = false;
let delayMac = false;
const browser = await chromium.launch({ channel: "chromium", headless: true });
// Evaluate imports in each page: module state belongs to that device.
async function device(): Promise<Page> {
  const context = await browser.newContext();
  await context.route("**/__peer_cloud?*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).searchParams.get("path")!;
    if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
    switch (request.method()) {
      case "POST":
        await route.fulfill({ json: [...files].filter(([p]) => p.startsWith(`${path}/`)).map(([p, v]) => ({ path: p, rev: String(v.rev), size: v.bytes.length })) });
        break;
      case "PUT":
        if (delayMac && path.startsWith("signal/mac/") && path.endsWith(".answer.bin")) await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (path.endsWith(".offer.bin") && failOffers > 0) {
          failOffers--;
          await route.fulfill({ status: 503 });
        } else if (path.endsWith(".answer.bin") && failAnswers > 0) {
          failAnswers--;
          await route.fulfill({ status: 503 });
        } else {
          files.set(path, { bytes: request.postDataBuffer()!, rev: ++revision });
          await route.fulfill({ status: 204 });
        }
        break;
      case "DELETE":
        files.delete(path);
        await route.fulfill({ status: 204 });
        break;
      default: {
        reads++;
        if (path.endsWith(".offer.bin") && failOfferReads > 0) {
          failOfferReads--;
          await route.fulfill({ status: 503 });
          break;
        }
        const file = files.get(path);
        if (file && unreachable && path.startsWith("signal/unreachable/") && path.endsWith(".answer.bin")) {
          await unreachable.evaluate(async () => (await import("/tests/sync-peer-fixture.ts")).closeConnections());
          blockedAnswerRead = true;
        }
        await route.fulfill(file ? { body: file.bytes } : { status: 404 });
      }
    }
  });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

try {
  const mac = await device();
  const phone = await device();
  const key = await mac.evaluate(async () => (await import("/tests/sync-peer-fixture.ts")).setup("mac"));
  await phone.evaluate(async (key) => (await import("/tests/sync-peer-fixture.ts")).setup("phone", key), key);
  await mac.evaluate(async () => {
    const f = await import("/tests/sync-peer-fixture.ts");
    await f.seed("volume");
    f.serve();
  });
  for (let run = 0; run < 3; run++) {
    const result = await phone.evaluate(async (run) => {
      const f = await import("/tests/sync-peer-fixture.ts");
      const result = await f.download("volume", `received-${run}`);
      await f.verify(`received-${run}`);
      return result;
    }, run);
    assert.ok(result.size > 32 * 1024 * 1024);
    console.log(`32 MiB run ${run + 1}: ${JSON.stringify(result)}`);
  }
  if (process.env.BASELINE !== "1") {
    await mac.evaluate(async () => (await import("/tests/sync-peer-fixture.ts")).seed("metadata", 2, 128 * 1024, true));
    await phone.evaluate(async () => {
      const f = await import("/tests/sync-peer-fixture.ts");
      await f.download("metadata", "metadata");
      await f.verify("metadata", 2, 128 * 1024);
    });
    console.log("✓ metadata larger than SCTP's limit arrives over the real channel");
    failAnswers = 3;
    failOffers = 3;
    failOfferReads = 1;
    latency = 100;
    const result = await phone.evaluate(async () => {
      const f = await import("/tests/sync-peer-fixture.ts");
      const result = await f.download("volume", "answer-retry");
      await f.verify("answer-retry");
      return result;
    });
    assert.equal(failAnswers, 0);
    assert.equal(failOffers, 0);
    assert.equal(failOfferReads, 0);
    assert.ok(result.stages.filter((stage) => stage === "ringing").length >= 2, "failed signaling gets a fresh attempt");
    console.log(`✓ failed answer upload recovered: ${JSON.stringify(result)}`);
    latency = 0;
    const simultaneous = await phone.evaluate(async () => {
      const f = await import("/tests/sync-peer-fixture.ts");
      const result = await Promise.all([f.download("volume", "parallel-1"), f.download("volume", "parallel-2")]);
      await f.verify("parallel-1");
      await f.verify("parallel-2");
      return result;
    });
    console.log(`✓ simultaneous downloads: ${JSON.stringify(simultaneous)}`);
    unreachable = await device();
    await unreachable.evaluate(async (key) => {
      const f = await import("/tests/sync-peer-fixture.ts");
      await f.setup("unreachable", key);
      f.serve();
    }, key);
    delayMac = true;
    const raced = await phone.evaluate(async () => {
      const f = await import("/tests/sync-peer-fixture.ts");
      const result = await f.download("volume", "raced", ["unreachable", "mac"]);
      await f.verify("raced");
      return result;
    });
    assert.equal(blockedAnswerRead, true, "the unreachable device really answered");
    assert.equal(raced.stages.filter((stage) => stage === "ringing").length, 1, "another device connected in the same attempt");
    console.log(`✓ unreachable first answer cannot block the reachable device: ${JSON.stringify(raced)}`);
    delayMac = false;
    await unreachable.context().close();
    unreachable = null;
    await phone.evaluate(async () => {
      const f = await import("/tests/sync-peer-fixture.ts");
      f.faults.dropAfter = 4 * 1024 * 1024;
    });
    const recovered = await phone.evaluate(async () => {
      const f = await import("/tests/sync-peer-fixture.ts");
      const result = await f.download("volume", "reconnected");
      await f.verify("reconnected");
      return result;
    });
    assert.equal(await phone.evaluate(async () => (await import("/tests/sync-peer-fixture.ts")).faults.dropped), true);
    console.log(`✓ broken channel reconnected: ${JSON.stringify(recovered)}`);
  }
  await mac.evaluate(async () => (await import("/tests/sync-peer-fixture.ts")).dispose());
  console.log(`sync-peer-smoke: passed; ${reads} cloud reads; no book bytes in the cloud`);
  assert.ok([...files].every(([, file]) => file.bytes.length < 10_000));
} finally {
  await browser.close();
}
