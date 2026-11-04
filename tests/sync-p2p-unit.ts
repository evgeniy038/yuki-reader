import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { planPack, type PackSource } from "../src/core/sync/book-pack.ts";
import { catalogPath, holdersOf } from "../src/core/sync/catalog.ts";
import { syncRound, type LocalBridge } from "../src/core/sync/engine.ts";
import { createInstaller, streamPack } from "../src/core/sync/pack-stream.ts";
import type { RemoteEntry, RemoteFolder } from "../src/core/sync/remote.ts";
import { answerPath, offerPath, parseSignal, readSignal, SIGNAL_TTL_MS, writeSignal } from "../src/core/sync/signal.ts";
import { createSyncStore } from "../src/core/sync/store.ts";
import { createVault, unlockVault } from "../src/core/sync/vault.ts";
import { loadBookContent, loadManga, loadMangaPageBlob, loadShelfBooks } from "../src/core/storage.ts";
import { ACK_EVERY, parseMessage, receiveBook, sendBook, WINDOW } from "../src/components/sync/p2p-wire.ts";

// The pieces of a direct device-to-device transfer that run without a
// browser: the pack stream (sent in frames, received in pieces of any size,
// stored file by file), the sealed doorbell signals, and the device
// catalogs the engine publishes so other devices can offer "on Mac" tiles.
// The WebRTC leg itself is covered by tests/sync-smoke.ts in real Chrome.
// Run: pnpm tsx tests/sync-p2p-unit.ts

class MemoryFolder implements RemoteFolder {
  readonly kind = "memory";
  readonly files = new Map<string, Uint8Array>();
  writes = 0;
  async list(dir: string): Promise<RemoteEntry[]> {
    return [...this.files]
      .filter(([path]) => path.startsWith(`${dir}/`))
      .map(([path, bytes]) => ({ path, rev: `${bytes.length}:${bytes[bytes.length - 1]}`, size: bytes.length }));
  }
  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.files.set(path, bytes.slice());
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const bytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 17 + seed) & 0xff);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// A seeded generator: piece sizes vary, the run stays reproducible.
let seed = 42;
const random = (max: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return 1 + (seed % max);
};

// --- the stream: frames out, pieces of any size in, file by file ----------
{
  const pages = [bytes(70_000, 1), bytes(0, 2), bytes(130_001, 3), bytes(5, 4)];
  const source: PackSource = {
    record: { id: "src", title: "推しの子 第03巻", format: "manga", progress: 0.5, addedAt: 1, chapters: [] },
    manga: {
      record: { id: "src", pages: pages.map((_, i) => ({ path: `${i}.jpg`, img_width: 10, img_height: 14 })) },
      page: async (index) => new Blob([pages[index]! as BlobPart], { type: "image/png" }),
    },
  };
  const plan = (await planPack(source))!;
  const frames: Uint8Array[] = [];
  await streamPack(plan, 64 * 1024, async (frame) => {
    assert.ok(frame.length <= 64 * 1024, "frames respect the channel's message size");
    frames.push(frame.slice());
  });
  const stream = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
  let at = 0;
  for (const frame of frames) {
    stream.set(frame, at);
    at += frame.length;
  }
  assert.equal(stream.length, plan.manifest.size, "the stream is every file back to back");

  const installer = createInstaller(plan.manifest, "p-1", { progress: 0.5, addedAt: 9 });
  for (let offset = 0; offset < stream.length; ) {
    const size = Math.min(random(40_000), stream.length - offset);
    await installer.push(stream.subarray(offset, offset + size));
    offset += size;
  }
  assert.equal(installer.received, plan.manifest.size);
  await installer.finish();
  const volume = await loadManga("p-1");
  assert.equal(volume?.pages.length, 4, "every page record arrives");
  for (const [index, page] of pages.entries()) {
    const blob = await loadMangaPageBlob("p-1", index);
    assert.ok(blob && same(new Uint8Array(await blob.arrayBuffer()), page), `page ${index} arrives exactly (empty ones too)`);
  }
  const shelf = (await loadShelfBooks()).find((book) => book.id === "p-1");
  assert.equal(shelf?.progress, 0.5, "the receiver's own position, not the sender's record");

  // Too many bytes, or too few: never a book.
  const greedy = createInstaller(plan.manifest, "p-2", { progress: 0, addedAt: 1 });
  await greedy.push(stream);
  await assert.rejects(greedy.push(new Uint8Array(1)), "a byte past the end is refused");
  await greedy.abort();
  const short = createInstaller(plan.manifest, "p-3", { progress: 0, addedAt: 1 });
  await short.push(stream.subarray(0, stream.length - 10));
  await assert.rejects(short.finish(), "a stream cut short doesn't finish");
  await short.abort();
  assert.equal(await loadManga("p-3"), undefined, "an aborted transfer leaves no volume");
  assert.equal(await loadMangaPageBlob("p-3", 0), undefined, "…and no stray page");
  assert.ok(!(await loadShelfBooks()).some((book) => book.id === "p-3"));
  console.log("  ✓ stream: frames out, any pieces in, exact files, nothing half-stored");
}

// --- a novel over the stream, too ------------------------------------------
{
  const record = {
    id: "n",
    title: "キッチン",
    format: "epub" as const,
    progress: 0,
    addedAt: 3,
    chapters: [{ id: "c1", html: "<p>台所</p>" }],
    resources: [{ path: "a.png", mime: "image/png", bytes: bytes(200_000, 9) }],
  };
  const plan = (await planPack({ record }))!;
  const installer = createInstaller(plan.manifest, "n-1", { progress: 0.2, addedAt: 4 });
  await streamPack(plan, 64 * 1024, (frame) => installer.push(frame.slice()));
  await installer.finish();
  const content = await loadBookContent("n-1");
  assert.deepEqual(content?.chapters, record.chapters);
  assert.ok(same(content!.resources![0]!.bytes, record.resources[0]!.bytes), "resources arrive exactly");
  console.log("  ✓ novel: chapters and resources over the same stream");
}

// --- doorbell signals: sealed, paired, stale ones ignored -------------------
{
  const cloud = new MemoryFolder();
  const { binding: vault } = await createVault(cloud);
  const path = offerPath("phone", "mac");
  await writeSignal(cloud, vault, path, { v: 1, session: "s-1", sdp: "v=0 o=- 1 2 IN IP4 192.168.1.7", at: Date.now() });
  const raw = new TextDecoder().decode(cloud.files.get(path)!);
  assert.ok(!raw.includes("192.168.1.7"), "the offer — addresses included — is unreadable in the cloud");
  assert.equal((await readSignal(cloud, vault, path))?.session, "s-1", "the other device reads it back");
  assert.equal(await readSignal(cloud, vault, answerPath("mac", "phone")), null, "no answer yet");
  assert.equal(parseSignal({ v: 1, session: "x", sdp: "", at: Date.now() - SIGNAL_TTL_MS - 1 }), null, "a stale doorbell is ignored");
  // Moved to another path: bound to its own, it doesn't open.
  cloud.files.set(answerPath("mac", "phone"), cloud.files.get(path)!);
  assert.equal(await readSignal(cloud, vault, answerPath("mac", "phone")), null, "a signal moved to another path doesn't open");
  console.log("  ✓ signals: sealed, paired by session, stale and moved ones ignored");
}

// --- catalogs: each device publishes what it holds, the others read it ------
{
  const cloud = new MemoryFolder();
  const created = await createVault(cloud);
  const desc = { title: "推しの子 第04巻", format: "manga" as const, size: 250_000_000, series: "推しの子", volumeIndex: 4 };
  let held: Record<string, typeof desc> = { "m1:four": desc };
  const bridge = (catalog: () => Promise<Record<string, typeof desc>>): LocalBridge => ({
    snapshot: async () => ({ books: [], settings: {} }),
    apply: async () => {},
    localStats: async () => [],
    keyOf: () => undefined,
    ocrEngine: 5,
    finishedOcr: async () => null,
    applyOcr: async () => {},
    packSource: async () => null,
    catalog,
  });
  const macStore = createSyncStore("yuki-sync-p2p-mac");
  await macStore.setVault(created.binding);
  const mac = { id: "mac", platform: "mac" as const, app: "chrome" as const };
  const macRound = () => syncRound({ remote: cloud, store: macStore, vault: created.binding, device: mac, bridge: bridge(async () => held) });
  await macRound();
  assert.ok(cloud.files.has(catalogPath("mac")), "the Mac publishes its catalog");
  const raw = new TextDecoder().decode(cloud.files.get(catalogPath("mac"))!);
  assert.ok(!raw.includes("推しの子") && !raw.includes("m1:four"), "…sealed: no titles, no keys");
  const writes = cloud.writes;
  await macRound();
  assert.equal(cloud.writes, writes, "an unchanged shelf rewrites nothing");

  const phoneStore = createSyncStore("yuki-sync-p2p-phone");
  const opened = await unlockVault(cloud, created.recoveryKey);
  await phoneStore.setVault(opened);
  const phone = { id: "phone", platform: "iphone" as const, app: "safari" as const };
  const phoneRound = () => syncRound({ remote: cloud, store: phoneStore, vault: opened, device: phone, bridge: bridge(async () => ({})) });
  await phoneRound();
  let seen = (await phoneStore.remoteCatalogs()).get("mac")?.catalog.books["m1:four"];
  assert.equal(seen?.title, "推しの子 第04巻", "the phone learns what the Mac holds");
  assert.equal(seen?.size, 250_000_000);

  held = {};
  await macRound();
  await phoneRound();
  seen = (await phoneStore.remoteCatalogs()).get("mac")?.catalog.books["m1:four"];
  assert.equal(seen, undefined, "a book gone from the Mac leaves its catalog");
  console.log("  ✓ catalogs: published sealed, read by the others, rewritten only on change");
}

// --- who to ring: every device that holds it, the first named on the tile -
{
  const desc = { title: "t", format: "manga" as const, size: 1 };
  const catalogs = new Map([
    ["mac-safari", { catalog: { v: 1 as const, books: { k: desc } } }],
    ["mac-chrome", { catalog: { v: 1 as const, books: { k: desc } } }],
    ["ipad", { catalog: { v: 1 as const, books: {} } }],
  ]);
  const devices = [{ id: "ipad" }, { id: "mac-safari" }, { id: "gone" }, { id: "mac-chrome" }];
  assert.deepEqual(holdersOf("k", devices, catalogs).map((d) => d.id), ["mac-safari", "mac-chrome"], "both Macs are rung, not just the first");
  assert.deepEqual(holdersOf("other", devices, catalogs), [], "nobody holds it: nobody is rung");
  console.log("  ✓ holders: every device that holds the book, in order");
}

// --- the wire's brake: never more than WINDOW ahead of what's STORED --------
// A phone writes to storage slower than Wi-Fi delivers; without the brake a
// 300 MB volume piles up in its page's memory and iOS kills the page.
{
  /** An in-memory data channel: what's sent lands on `peer`, a tick later. */
  class FakeWire extends EventTarget {
    readyState: RTCDataChannelState = "open";
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    peer: FakeWire | null = null;
    readonly sent: (string | Uint8Array)[] = [];
    send(data: string | ArrayBufferView | ArrayBuffer | Blob): void {
      const item = typeof data === "string" ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : data;
      if (!(typeof item === "string" || item instanceof Uint8Array)) throw new Error("unexpected payload");
      this.sent.push(item);
      const payload = typeof item === "string" ? item : item.slice().buffer;
      setTimeout(() => this.peer?.dispatchEvent(new MessageEvent("message", { data: payload })), 0);
    }
    close(): void {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const bytesSent = (wire: FakeWire) => wire.sent.reduce((sum, item) => sum + (typeof item === "string" ? 0 : item.length), 0);
  const settle = async (wire: FakeWire) => {
    for (let last = -1; last !== bytesSent(wire); ) {
      last = bytesSent(wire);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const pages = Array.from({ length: 40 }, (_, i) => bytes(1024 * 1024, i));
  const volume: PackSource = {
    record: { id: "big", title: "大きい巻", format: "manga", progress: 0, addedAt: 1, chapters: [] },
    manga: {
      record: { id: "big", pages: pages.map((_, i) => ({ path: `${i}.jpg` })) },
      page: async (index) => new Blob([pages[index]! as BlobPart], { type: "image/jpeg" }),
    },
  };
  const ack = (wire: FakeWire, stored: number) =>
    wire.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ t: "ack", stored }) }));

  // A receiver that stores nothing yet: the sender stops at the window.
  const tx = new FakeWire();
  const sending = sendBook(tx, volume, WINDOW);
  await settle(tx);
  assert.ok(bytesSent(tx) > 0 && bytesSent(tx) <= WINDOW, `a silent receiver gets at most the window (${bytesSent(tx)} B)`);
  ack(tx, 8 * 1024 * 1024);
  await settle(tx);
  assert.ok(bytesSent(tx) <= 8 * 1024 * 1024 + WINDOW, "each acknowledgement lets exactly that much more through");
  const size = (await planPack(volume))!.manifest.size;
  for (let stored = 0; stored < size; stored += ACK_EVERY) ack(tx, stored + ACK_EVERY);
  await sending;
  assert.equal(bytesSent(tx), size, "acknowledged to the end, the whole volume goes");
  assert.equal(parseMessage(String(tx.sent.at(-1)))?.t, "end");

  // An older receiver (no window asked): no brake, nothing stalls.
  const old = new FakeWire();
  await sendBook(old, volume, undefined);
  assert.equal(bytesSent(old), size, "an older receiver still gets the whole book");

  // Both ends for real: the receiver acknowledges as it stores.
  const [a, b] = [new FakeWire(), new FakeWire()];
  a.peer = b;
  b.peer = a;
  let peakAhead = 0;
  let stored = 0;
  b.addEventListener("message", (event) => {
    const message = typeof (event as MessageEvent).data === "string" ? parseMessage((event as MessageEvent).data) : null;
    if (message?.t === "get") void sendBook(b, volume, message.window);
  });
  a.addEventListener("message", () => (peakAhead = Math.max(peakAhead, bytesSent(b) - stored)));
  const record = await receiveBook(a, {
    key: "m1:big",
    id: "wired",
    personal: { progress: 0, addedAt: 1 },
    onProgress: (done) => (stored = done),
  });
  const acks = a.sent.flatMap((item) => (typeof item === "string" ? [parseMessage(item)] : [])).filter((m) => m?.t === "ack");
  assert.equal(parseMessage(String(a.sent[0]))?.t, "get");
  assert.ok(acks.length >= size / ACK_EVERY - 1, `the receiver acknowledges as it stores (${acks.length} acks)`);
  assert.ok(peakAhead <= WINDOW + 64 * 1024, `never more than the window waiting to be stored (${(peakAhead / 1048576).toFixed(1)} MB)`);
  assert.equal(record.id, "wired");
  assert.ok(same(new Uint8Array(await (await loadMangaPageBlob("wired", 39))!.arrayBuffer()), pages[39]!), "…and the last page arrives exactly");
  console.log("  ✓ wire: the sender stays within the window of what the receiver stored");
}

console.log("sync-p2p-unit: all checks passed");
