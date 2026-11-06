import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright-core";

const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
const receiver = process.env.YUKI_TEST_WEBKIT === "1" ? await webkit.launch({ headless: true }) : browser;
const base = process.env.YUKI_TEST_BASE ?? "http://localhost:1480";
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Connection condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  const left = await (await browser.newContext()).newPage();
  const right = await (await receiver.newContext()).newPage();
  await Promise.all([left.goto(base), right.goto(base)]);
  const secret = randomUUID();
  await Promise.all([
    left.evaluate(async (secret) => (await import("/tests/sync-link-fixture.ts")).prepare(secret, 0), secret),
    right.evaluate(async (secret) => (await import("/tests/sync-link-fixture.ts")).prepare(secret, 1), secret),
  ]);
  const leftState = () => left.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).state());
  const rightState = () => right.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).state());
  await until(async () => (await leftState()).connected && (await rightState()).connected);
  const before = [await leftState(), await rightState()];
  await right.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).loseSignaling());
  await until(async () => (await rightState()).opened > before[1]!.opened);
  await left.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).send(1024 * 1024));
  await until(async () => (await rightState()).bytes === 1024 * 1024);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal((await leftState()).pcs, before[0]!.pcs, "signaling reconnect must preserve the sender's working RTC connection");
  assert.equal((await rightState()).pcs, before[1]!.pcs, "signaling reconnect must preserve the receiver's working RTC connection");
  await right.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).staleCandidate());
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal((await rightState()).pcs, before[1]!.pcs, "one rejected ICE candidate cannot discard a healthy connection");
  assert.equal((await rightState()).connected, true);
  await left.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).send(1024));
  await until(async () => (await rightState()).bytes === 1024 * 1024 + 1024);
  console.log("✓ signaling reconnection and a stale ICE candidate preserve the same live data channel");
  const beforeSleep = [await leftState(), await rightState()];
  await right.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).resumeAfterSleep());
  await right.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).restartTransport());
  await until(async () => (await leftState()).ufrag !== before[0]!.ufrag && (await rightState()).ufrag !== before[1]!.ufrag);
  await left.evaluate(async () => (await import("/tests/sync-link-fixture.ts")).send(1024));
  await until(async () => (await rightState()).bytes === 1024 * 1024 + 2048);
  // Outlive the negotiation deadline: a completed ICE restart must not
  // leave behind a timer that replaces the working transport later.
  await new Promise((resolve) => setTimeout(resolve, 27_000));
  assert.equal((await leftState()).pcs, before[0]!.pcs);
  assert.equal((await rightState()).pcs, before[1]!.pcs);
  assert.deepEqual((await leftState()).states, ["true"]);
  assert.deepEqual((await rightState()).states, ["true"]);
  assert.equal((await rightState()).opened, beforeSleep[1]!.opened, "resuming after sleep probes the socket instead of treating suspended time as a missed heartbeat");
  console.log("✓ resume after suspension and an ICE restart preserve the transport and stable status beyond the handshake deadline");
} finally { await browser.close(); if (receiver !== browser) await receiver.close(); }
