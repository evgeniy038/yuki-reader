import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";

// A Storage for the synced settings the bridge reads (node has none).
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  },
});
// The OCR pool reads its debug flags from the address at import.
Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
// No model download may leave this test: the OCR queue's fetch fails.
globalThis.fetch = async () => {
  throw new TypeError("offline in tests");
};

const { installPack, manifestPath, packDir, parsePackManifest, planPack, readManifest } = await import("../src/core/sync/book-pack.ts");
const { folderName } = await import("../src/core/sync/crypto.ts");
const { syncRound } = await import("../src/core/sync/engine.ts");
const { createInstaller, streamPack } = await import("../src/core/sync/pack-stream.ts");
const { isReady, processingOf } = await import("../src/core/sync/ready.ts");
const { createSyncStore } = await import("../src/core/sync/store.ts");
const { createVault } = await import("../src/core/sync/vault.ts");
const { ocrPath } = await import("../src/core/sync/ocr-sync.ts");
const storageApi = await import("../src/core/storage.ts");
const { MANGA_OCR, open } = await import("../src/core/storage/db.ts");
const { createBridge, packSourceOf } = await import("../src/components/sync/sync-bridge.ts");
const { catalogOf } = await import("../src/components/sync/sync-catalog.ts");
const { forgetReadiness, readinessOf } = await import("../src/components/sync/sync-ready.ts");
const { parseMessage, receiveBook, sendBook } = await import("../src/components/sync/p2p-wire.ts");
const { onOcrBooks, resumeMangaOcr, trackMangaOcr, cancelOcr } = await import("../src/core/ocr/ocr.ts");
type Book = import("../src/core/library.ts").Book;
type BookRecord = import("../src/core/storage.ts").BookRecord;
type MokuroBlock = import("../src/core/mokuro.ts").MokuroBlock;
type RemoteEntry = import("../src/core/sync/remote.ts").RemoteEntry;
type RemoteFolder = import("../src/core/sync/remote.ts").RemoteFolder;
type SyncHost = import("../src/components/sync/sync-bridge.ts").SyncHost;

const { OCR_ENGINE, loadManga, loadMangaOcr, putBook, putMangaOcrDetect, putMangaOcrFinal, putMangaVolume } = storageApi;

// A book is offered to the other devices only once it is fully processed
// on its own (core/sync/ready.ts): the readiness gate, the catalog and the
// uploads and direct transfers behind it, the OCR that travels INSIDE the
// pack or stream, and the rule that a received volume is never recognized
// again — not by the OCR queue's resume pass, not on demand.
// Run: pnpm tsx tests/sync-ready-unit.ts

class MemoryFolder implements RemoteFolder {
  readonly kind = "memory";
  readonly files = new Map<string, Uint8Array>();
  async list(dir: string): Promise<RemoteEntry[]> {
    return [...this.files]
      .filter(([path]) => path.startsWith(`${dir}/`))
      .map(([path, bytes]) => ({ path, rev: `${bytes.length}:${bytes[bytes.length - 1]}`, size: bytes.length }));
  }
  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const bytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 13 + seed) & 0xff);
const block = (text: string): MokuroBlock => ({ box: [1, 2, 30, 40], vertical: true, font_size: 12, lines: [text] });
const sidecar = [block("サイドカー")];

/** A manga volume in storage: page 0 has sidecar boxes, the others need OCR. */
async function storeVolume(id: string, pages: number, extra: Partial<BookRecord> = {}): Promise<Book> {
  const book: Book = { id, title: `巻 ${id}`, format: "manga", progress: 0, addedAt: 1, pageCount: pages, series: "テスト", volumeIndex: 1, ...extra };
  await putBook({ ...book, chapters: [] });
  await putMangaVolume(
    { id, pages: Array.from({ length: pages }, (_, i) => ({ path: `${i}.jpg`, img_width: 100, img_height: 140, ...(i === 0 ? { blocks: sidecar } : {}) })) },
    Array.from({ length: pages }, (_, i) => new Blob([bytes(800 + i, i + id.length) as BlobPart], { type: "image/jpeg" })),
  );
  return book;
}

/** An OCR record from an older engine, written as an older build would. */
async function putOldEngine(id: string, page: number): Promise<void> {
  const db = await open();
  await db.put(MANGA_OCR, { blocks: [block("古い")], engine: OCR_ENGINE - 1 }, `${id}/${page}`);
}

const hostOf = (books: Book[]): SyncHost => ({
  ready: () => true,
  books: () => books,
  patch: () => {},
  remove: () => {},
  add: (book) => void books.push(book),
  settingsApplied: () => {},
});

// --- the readiness gate ------------------------------------------------------
{
  const novel: BookRecord = { id: "g-novel", title: "キッチン", format: "epub", progress: 0, addedAt: 1, chapters: [{ id: "c1", html: "<p>台所</p>" }] };
  assert.equal(await processingOf(novel.id, "epub"), null, "a novel whose import hasn't stored yet isn't offered");
  await putBook(novel);
  assert.ok(isReady(await processingOf(novel.id, "epub")), "…and is, the moment it is stored");

  await storeVolume("g-vol", 3);
  assert.deepEqual(await processingOf("g-vol", "manga"), { done: 0, total: 2, received: false }, "pages with sidecar boxes don't count");
  await putMangaOcrDetect("g-vol", 1, [block("")], [[1, 2, 30, 40]]);
  assert.equal((await processingOf("g-vol", "manga"))?.done, 0, "a detect-only skeleton isn't text yet");
  await putMangaOcrFinal("g-vol", 1, [block("一")]);
  await putOldEngine("g-vol", 2);
  assert.deepEqual(await processingOf("g-vol", "manga"), { done: 1, total: 2, received: false }, "an older engine's page counts as missing");
  assert.ok(!isReady(await processingOf("g-vol", "manga")));
  await putMangaOcrFinal("g-vol", 2, [block("二")]);
  assert.ok(isReady(await processingOf("g-vol", "manga")), "every page recognized at the current engine: ready");

  await storeVolume("g-side", 1);
  assert.ok(isReady(await processingOf("g-side", "manga")), "a sidecar-only volume is ready as imported");
  assert.equal(await processingOf("g-missing", "manga"), null, "a volume whose pages aren't stored yet isn't offered");
  console.log("  ✓ gate: stored novels, fully recognized volumes — nothing half-processed");
}

// --- only ready books are offered: catalog, upload, direct transfer ---------
const remote = new MemoryFolder();
const { binding: vault } = await createVault(remote);
const macBooks: Book[] = [];
const macHost = hostOf(macBooks);
{
  macBooks.push(await storeVolume("mac-vol", 3, { keepInCloud: true }));
  const novel: BookRecord = { id: "mac-novel", title: "TUGUMI", format: "epub", progress: 0, addedAt: 2, chapters: [{ id: "c1", html: "<p>つぐみ</p>" }] };
  await putBook(novel);
  macBooks.push({ id: novel.id, title: novel.title, format: "epub", progress: 0, addedAt: 2 });
  await putMangaOcrFinal("mac-vol", 1, [block("途中")]);

  const store = createSyncStore("yuki-sync-ready-mac");
  await store.setVault(vault);
  const bridge = await createBridge(macHost);
  const volKey = bridge.keyOf("mac-vol")!;
  const novelKey = bridge.keyOf("mac-novel")!;
  assert.ok(volKey && novelKey, "both books have content keys");
  const mac = { id: "devMac", platform: "mac" as const, app: "chrome" as const };
  await syncRound({ remote, store, vault, device: mac, bridge });

  const volDir = packDir(mac.id, await folderName(vault.keys, volKey));
  const novelDir = packDir(mac.id, await folderName(vault.keys, novelKey));
  assert.ok(remote.files.has(manifestPath(novelDir)), "the stored novel goes up");
  assert.ok(!remote.files.has(manifestPath(volDir)), "a volume still being recognized doesn't, even kept in the cloud");
  assert.ok(![...remote.files.keys()].some((path) => path.startsWith(`${volDir}/`)), "…not even a part of it");
  assert.equal(await packSourceOf(macHost, "mac-vol"), null, "…and a direct request for it gets nothing");
  let catalog = await bridge.catalog();
  assert.equal(catalog[volKey]?.prep, 0.5, "the catalog shows it waiting, with how far it got");
  assert.equal(catalog[novelKey]?.prep, undefined, "the novel is listed ready");
  assert.equal((await store.shadow())?.books[volKey]?.ocr, undefined, "no OCR pack for an unfinished volume");

  // The last page recognized: the next round offers it everywhere at once.
  await putMangaOcrFinal("mac-vol", 2, [block("終わり")]);
  forgetReadiness("mac-vol");
  const phases: string[] = [];
  const uploaded: number[] = [];
  await syncRound({
    remote,
    store,
    vault,
    device: mac,
    bridge,
    onProgress: ({ phase, done, total }) => {
      assert.ok(done <= total, `a step never runs past its length (${phase} ${done}/${total})`);
      if (phases.at(-1) !== phase) phases.push(phase);
    },
    onUpload: (key, title, sent, total) => {
      assert.equal(key, volKey);
      assert.equal(title, "巻 mac-vol");
      uploaded.push(sent / total);
    },
  });
  assert.deepEqual(phases, ["pull", "push", "files"], "a round reports its steps in order");
  assert.equal(uploaded.at(-1), 1, "the volume's upload reports up to all of it");
  assert.ok(remote.files.has(manifestPath(volDir)), "a fully recognized volume goes up");
  const manifest = (await readManifest(remote, vault, volDir))!;
  assert.equal(manifest.ocr?.engine, OCR_ENGINE, "…with its text inside the pack");
  catalog = await bridge.catalog();
  assert.equal(catalog[volKey]?.prep, undefined, "…and the catalog lists it ready");
  const regs = (await store.shadow())?.books[volKey];
  assert.equal(regs?.ocr?.v, OCR_ENGINE, "its OCR pack is published in the same round (engine bumps travel that way)");
  assert.ok(remote.files.has(ocrPath(mac.id, await folderName(vault.keys, volKey))));
  const source = await packSourceOf(macHost, "mac-vol");
  assert.equal(source?.manga?.ocr?.pages.size, 2, "a direct transfer would carry both recognized pages");
  console.log("  ✓ offered only once processed: no upload, no transfer, a waiting tile until then");
}

// --- OCR travels inside the transfer ----------------------------------------
{
  const volDirKey = (await createBridge(macHost)).keyOf("mac-vol")!;
  const dir = packDir("devMac", await folderName(vault.keys, volDirKey));
  const manifest = (await readManifest(remote, vault, dir))!;

  // From the cloud.
  await installPack(remote, vault, dir, manifest, "phone-cloud", { progress: 0, addedAt: 3 });
  const fromCloud = await loadManga("phone-cloud");
  assert.equal(fromCloud?.received, true, "a downloaded volume knows it came from another device");
  const cloudText = await loadMangaOcr("phone-cloud");
  assert.deepEqual(cloudText.get(2)?.blocks, [block("終わり")], "its text is there the moment it lands");
  assert.ok(isReady(await processingOf("phone-cloud", "manga")), "…so there is nothing left to recognize");

  // Straight from the Mac, over the wire.
  class FakeWire extends EventTarget {
    readyState: RTCDataChannelState = "open";
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    peer: FakeWire | null = null;
    send(data: string | ArrayBufferView | ArrayBuffer | Blob): void {
      const payload = typeof data === "string" ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
      setTimeout(() => this.peer?.dispatchEvent(new MessageEvent("message", { data: payload })), 0);
    }
    close(): void {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
  }
  const [phone, macEnd] = [new FakeWire(), new FakeWire()];
  phone.peer = macEnd;
  macEnd.peer = phone;
  macEnd.addEventListener("message", (event) => {
    const message = typeof (event as MessageEvent).data === "string" ? parseMessage((event as MessageEvent).data) : null;
    if (message?.t === "get") void packSourceOf(macHost, "mac-vol").then((src) => sendBook(macEnd, src, message.window));
  });
  await receiveBook(phone, { key: volDirKey, id: "phone-direct", personal: { progress: 0, addedAt: 4 }, onProgress: () => {} });
  assert.equal((await loadManga("phone-direct"))?.received, true);
  assert.deepEqual((await loadMangaOcr("phone-direct")).get(1)?.blocks, [block("途中")], "a direct transfer brings the text too");
  assert.ok(isReady(await processingOf("phone-direct", "manga")));

  // Another engine's text is left out (counts as missing), the volume still comes.
  const source = (await packSourceOf(macHost, "mac-vol"))!;
  const stale = (await planPack({ ...source, manga: { ...source.manga!, ocr: { engine: OCR_ENGINE - 1, pages: source.manga!.ocr!.pages } } }))!;
  const frames: Uint8Array[] = [];
  await streamPack(stale, 64 * 1024, async (frame) => void frames.push(frame.slice()));
  const installer = createInstaller(stale.manifest, "phone-stale", { progress: 0, addedAt: 5 });
  for (const frame of frames) await installer.push(frame);
  await installer.finish();
  assert.equal((await loadMangaOcr("phone-stale")).size, 0, "an older engine's text is never applied");
  assert.equal((await loadManga("phone-stale"))?.pages.length, 3, "…but the volume arrives");

  // A pack from before (no text inside) still reads and installs.
  const { ocr: _ocr, ...older } = manifest;
  const reparsed = parsePackManifest(JSON.parse(JSON.stringify(older)) as unknown);
  assert.ok(reparsed && reparsed.ocr === undefined, "a 1.4.4 manifest still parses");
  assert.equal(parsePackManifest({ ...JSON.parse(JSON.stringify(manifest)), ocr: { file: 999, engine: 5 } }), null, "text pointing past the stream is refused");
  console.log("  ✓ text inside the transfer: cloud pack and direct stream, current engine only");
}

// --- a received volume is never recognized again ----------------------------
{
  const tracked = new Set<string>();
  const stop = onOcrBooks((books) => {
    for (const { bookId } of books) tracked.add(bookId);
  });
  // Received without text (an older pack whose device hadn't finished).
  const book = await storeVolume("phone-bare", 3);
  const record = await loadManga("phone-bare");
  await storageApi.putMangaRecord({ ...record!, received: true });
  await trackMangaOcr("phone-bare");
  assert.ok(!tracked.has("phone-bare"), "the OCR queue never takes a received volume");
  // A volume imported here, unfinished, for contrast.
  await storeVolume("phone-own", 2);
  resumeMangaOcr();
  for (let i = 0; i < 50 && !tracked.has("phone-own"); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(tracked.has("phone-own"), "the resume pass picks up this device's own unfinished volume");
  for (const id of ["phone-bare", "phone-cloud", "phone-direct", "phone-stale"]) {
    assert.ok(!tracked.has(id), `…and none of the received ones (${id})`);
  }
  cancelOcr("phone-own");
  stop();

  // It waits for its own device's text: never offered from here meanwhile.
  const phoneHost = hostOf([book]);
  forgetReadiness("phone-bare");
  assert.deepEqual(await catalogOf([book], () => "m1:bare"), {}, "a received volume without text isn't listed here");
  assert.equal(await packSourceOf(phoneHost, "phone-bare"), null, "…nor sent on");
  const ready = { ...book, id: "phone-cloud" };
  assert.ok((await catalogOf([ready], () => "m1:cloud"))["m1:cloud"], "with its text it can be passed on");
  assert.equal((await readinessOf("phone-cloud", "manga"))?.received, true);
  console.log("  ✓ received volumes: never queued for OCR, passed on only with text");
}

console.log("sync-ready-unit: all checks passed");
