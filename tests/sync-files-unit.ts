import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import {
  installPack,
  manifestPath,
  packDir,
  CHUNK_BYTES,
  chunkPath,
  planPack,
  readManifest,
  uploadPack,
  type PackSource,
} from "../src/core/sync/book-pack.ts";
import { folderName } from "../src/core/sync/crypto.ts";
import { syncRound, type LocalBridge } from "../src/core/sync/engine.ts";
import type { LocalBook, LocalState } from "../src/core/sync/merge.ts";
import type { RemoteEntry, RemoteFolder } from "../src/core/sync/remote.ts";
import { createSyncStore, type VaultBinding } from "../src/core/sync/store.ts";
import { createVault, unlockVault } from "../src/core/sync/vault.ts";
import {
  loadBookContent,
  loadManga,
  loadMangaPageBlob,
  loadShelfBooks,
  type BookRecord,
} from "../src/core/storage.ts";

// Book files across devices (core/sync/book-pack.ts + files.ts): a pack
// round-trips byte for byte, an upload broken off mid-way resumes from the
// parts already in the cloud with the manifest strictly last, a tampered
// part never becomes a half-stored book, and the real engine uploads EPUB
// on its own, manga only with "keep in the cloud", on a time budget, and
// takes a deleted book's pack back out. Run: pnpm tsx tests/sync-files-unit.ts

class MemoryFolder implements RemoteFolder {
  readonly kind = "memory";
  readonly files = new Map<string, Uint8Array>();
  writes = 0;
  /** Writes allowed before the "network" breaks (Infinity = never). */
  breakAfter = Infinity;
  async list(dir: string): Promise<RemoteEntry[]> {
    return [...this.files]
      .filter(([path]) => path.startsWith(`${dir}/`))
      .map(([path, bytes]) => ({ path, rev: String(bytes.length), size: bytes.length }));
  }
  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    if (this.writes >= this.breakAfter) throw new TypeError("network went away");
    this.writes += 1;
    this.files.set(path, bytes.slice());
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const bytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const novel: BookRecord = {
  id: "n-1",
  title: "キッチン",
  author: "吉本ばなな",
  language: "ja",
  format: "epub",
  progress: 0.42,
  favorite: true,
  addedAt: 1_700_000_000_000,
  chapters: [
    { id: "c1", html: "<p>台所が好きだ。</p>" },
    { id: "c2", html: "<p>満月</p>", title: "満月" },
  ],
  toc: [{ label: "満月", chapterId: "c2" }],
  bookCss: "p { margin: 0 }",
  // One illustration over a part: the resource is cut into two.
  resources: [
    { path: "img/a.jpg", mime: "image/jpeg", bytes: bytes(CHUNK_BYTES + 1234, 7) },
    { path: "css/b.css", mime: "text/css", bytes: bytes(300, 3) },
  ],
};

const cloud = new MemoryFolder();
const { binding: vault, recoveryKey } = await createVault(cloud);

// --- a pack round-trips, and a broken upload resumes ------------------------
{
  const plan = await planPack({ record: novel });
  assert.ok(plan, "a stored novel plans into a pack");
  const totalParts = plan.manifest.chunks;
  assert.equal(totalParts, 2, "record, illustration and stylesheet back to back: two chunks");
  assert.equal(plan.manifest.files[1]!.offset, plan.manifest.files[0]!.size, "files sit right after each other");
  assert.equal(plan.manifest.desc.title, "キッチン");
  assert.equal(
    plan.manifest.desc.size,
    plan.manifest.files.reduce((sum, file) => sum + file.size, 0),
    "the tile's size is every file together",
  );
  const dir = packDir("devA", await folderName(vault.keys, "e1:kitchen"));

  cloud.writes = 0;
  cloud.breakAfter = 1;
  await assert.rejects(uploadPack(cloud, vault, dir, plan, new Set(), Date.now() + 60_000));
  assert.equal(cloud.writes, 1, "one chunk made it before the break (the other retried, then gave up)");
  assert.ok(!cloud.files.has(manifestPath(dir)), "no manifest until every part is up");

  cloud.breakAfter = Infinity;
  const existing = new Set((await cloud.list(dir)).map((entry) => entry.path));
  const before = cloud.writes;
  const resumed = await uploadPack(cloud, vault, dir, plan, existing, Date.now() + 60_000);
  assert.ok(resumed.done, "the second try finishes");
  assert.equal(cloud.writes - before, totalParts - 1 + 1, "only the missing chunk, then the manifest");
  const sealedTitle = [...cloud.files.values()].some((file) =>
    new TextDecoder().decode(file).includes("台所"),
  );
  assert.ok(!sealedTitle, "nothing in the cloud is readable");

  const manifest = await readManifest(cloud, vault, dir);
  assert.ok(manifest, "the manifest reads back");
  let lastDone = 0;
  const stored = await installPack(cloud, vault, dir, manifest, "local-9", { progress: 0.42, addedAt: 5, favorite: true }, (done) => {
    lastDone = done;
  });
  assert.equal(lastDone, manifest.desc.size, "progress reaches the whole size");
  assert.equal(stored.id, "local-9");
  const shelf = (await loadShelfBooks()).find((book) => book.id === "local-9");
  assert.equal(shelf?.title, "キッチン");
  assert.equal(shelf?.progress, 0.42, "personal state comes from the caller, not the pack");
  const content = await loadBookContent("local-9");
  assert.deepEqual(content?.chapters, novel.chapters, "chapters arrive as written");
  assert.deepEqual(content?.toc, novel.toc);
  assert.equal(content?.bookCss, novel.bookCss);
  assert.ok(same(content!.resources![0]!.bytes, novel.resources![0]!.bytes), "the two-part image joins back exactly");
  assert.ok(same(content!.resources![1]!.bytes, novel.resources![1]!.bytes));
  console.log("  ✓ pack: round-trip byte for byte, broken upload resumes, manifest last");
}

// --- manga pages land page by page; a tampered part leaves nothing ----------
{
  // Big enough pages for two chunks (a swap needs two).
  const pages = [bytes(5_000_000, 1), bytes(5_000_000, 2), bytes(700, 3)];
  const source: PackSource = {
    record: { id: "m-1", title: "推しの子 第02巻", format: "manga", progress: 0, addedAt: 1, chapters: [], pageCount: 3, series: "推しの子", volumeIndex: 2 },
    manga: {
      record: { id: "m-1", pages: pages.map((_, i) => ({ path: `${i}.jpg`, img_width: 100, img_height: 140 })) },
      page: async (index) => (pages[index] ? new Blob([pages[index]! as BlobPart], { type: "image/jpeg" }) : undefined),
    },
  };
  const plan = await planPack(source);
  assert.ok(plan?.manifest.manga, "a volume plans with its pages");
  const dir = packDir("devA", await folderName(vault.keys, "m1:oshi"));
  assert.ok((await uploadPack(cloud, vault, dir, plan, new Set(), Date.now() + 60_000)).done);
  const manifest = (await readManifest(cloud, vault, dir))!;
  await installPack(cloud, vault, dir, manifest, "m-local", { progress: 0, addedAt: 2 });
  const record = await loadManga("m-local");
  assert.equal(record?.pages.length, 3, "the volume record arrives");
  const second = await loadMangaPageBlob("m-local", 1);
  assert.ok(second && same(new Uint8Array(await second.arrayBuffer()), pages[1]!), "page bytes arrive exactly");
  assert.equal(second?.type, "image/jpeg");

  // Swap two parts: each one is bound to its own path, so neither opens.
  const a = chunkPath(dir, 0);
  const b = chunkPath(dir, 1);
  const swap = cloud.files.get(a)!;
  cloud.files.set(a, cloud.files.get(b)!);
  cloud.files.set(b, swap);
  await assert.rejects(installPack(cloud, vault, dir, manifest, "m-bad", { progress: 0, addedAt: 3 }));
  assert.equal(await loadManga("m-bad"), undefined, "a failed download leaves no volume record");
  assert.equal(await loadMangaPageBlob("m-bad", 0), undefined, "…and no stray page");
  assert.ok(!(await loadShelfBooks()).some((book) => book.id === "m-bad"), "…and nothing on the shelf");
  console.log("  ✓ manga: pages land one by one, a tampered part never becomes a book");
}

// --- the engine: who uploads what, on a budget, and cleans up ---------------
{
  const remote = new MemoryFolder();
  const created = await createVault(remote);
  const records = new Map<string, BookRecord>([
    ["a-n", { ...novel, id: "a-n" }],
    ["a-m", { id: "a-m", title: "推しの子 第01巻", format: "manga", progress: 0, addedAt: 1, chapters: [] }],
  ]);
  const mangaPages = [bytes(500, 9), bytes(600, 8)];
  const library: LocalState = {
    books: [
      { id: "a-n", key: "e1:kitchen", title: "キッチン", progress: 0.4, lastReadAt: 1000, favorite: false, format: "epub" },
      { id: "a-m", key: "m1:oshi1", title: "推しの子 第01巻", progress: 0, favorite: false, format: "manga" },
    ] satisfies LocalBook[],
    settings: {},
  };
  const store = createSyncStore("yuki-sync-files-mac");
  await store.setVault(created.binding);
  const bridge: LocalBridge = {
    snapshot: async () => ({ books: library.books.map((book) => ({ ...book })), settings: {} }),
    apply: async () => {},
    localStats: async () => [],
    keyOf: (id) => library.books.find((book) => book.id === id)?.key,
    ocrEngine: 5,
    finishedOcr: async () => null,
    applyOcr: async () => {},
    catalog: async () => ({}),
    packSource: async (id) => {
      const record = records.get(id);
      if (!record) return null;
      if (record.format !== "manga") return { record };
      return {
        record,
        manga: {
          record: { id, pages: mangaPages.map((_, i) => ({ path: `${i}.jpg` })) },
          page: async (index) => new Blob([mangaPages[index]! as BlobPart]),
        },
      };
    },
  };
  const mac = { id: "devA", platform: "mac" as const, app: "chrome" as const };
  const round = (deadline?: number) =>
    syncRound({ remote, store, vault: created.binding, device: mac, bridge, filesDeadline: deadline });
  const novelDir = packDir("devA", await folderName(created.binding.keys, "e1:kitchen"));
  const mangaDir = packDir("devA", await folderName(created.binding.keys, "m1:oshi1"));

  const starved = await round(Date.now() - 1);
  assert.ok(starved.filesPending, "an exhausted budget leaves the upload for the next round");
  assert.ok(remote.files.has("devices/devA/state.bin"), "…while the reading state still goes out");
  assert.ok(!remote.files.has(manifestPath(novelDir)));

  // A 1.4.0 (v1) pack left inside the state folder.
  remote.files.set("devices/devA/books/0123456789abcdef0123456789abcdef/1.0.bin", new Uint8Array(8));
  const first = await round();
  assert.ok(!first.filesPending);
  assert.ok(
    !(await remote.list("devices")).some((entry) => entry.path.includes("/books/")),
    "book chunks never sit in the state folder (v1 leftovers are removed)",
  );
  assert.ok(remote.files.has(manifestPath(novelDir)), "a novel goes up on its own");
  assert.ok(!remote.files.has(manifestPath(mangaDir)), "a manga volume doesn't — it's hundreds of MB");
  let shadow = await store.shadow();
  assert.equal(shadow?.books["e1:kitchen"]?.file?.d, "devA", "the file register names the uploader");
  assert.equal(shadow?.books["m1:oshi1"]?.file, undefined);

  library.books[1] = { ...library.books[1]!, keep: true };
  await round();
  assert.ok(remote.files.has(manifestPath(mangaDir)), "\"keep in the cloud\" sends the volume");
  shadow = await store.shadow();
  assert.equal(shadow?.books["m1:oshi1"]?.keep?.v, true, "…and the wish travels as a register");

  // A second device sees both packs and can read them with the same key.
  const phoneStore = createSyncStore("yuki-sync-files-phone");
  const opened = await unlockVault(remote, created.recoveryKey);
  await phoneStore.setVault(opened);
  const phoneBridge: LocalBridge = { ...bridge, snapshot: async () => ({ books: [], settings: {} }), packSource: async () => null };
  await syncRound({ remote, store: phoneStore, vault: opened, device: { id: "devB", platform: "iphone", app: "safari" }, bridge: phoneBridge });
  const phoneShadow = await phoneStore.shadow();
  assert.equal(phoneShadow?.books["e1:kitchen"]?.file?.d, "devA", "the phone learns where the novel's files are");
  const remoteManifest = await readManifest(remote, opened, novelDir);
  assert.equal(remoteManifest?.desc.title, "キッチン", "…and opens its manifest with the shared key");

  // Deleted on the Mac: the tombstone goes out and the pack comes down.
  library.books = library.books.filter((book) => book.id !== "a-n");
  await round();
  assert.ok(![...remote.files.keys()].some((path) => path.startsWith(`${novelDir}/`)), "a deleted book's pack is removed");
  shadow = await store.shadow();
  assert.equal(shadow?.books["e1:kitchen"]?.file?.v, 0, "…and its register says so");
  assert.ok(remote.files.has(manifestPath(mangaDir)), "the volume kept in the cloud stays");

  // Keep switched off: the volume's pack comes down too.
  library.books[0] = { ...library.books[0]!, keep: false };
  await round();
  assert.ok(![...remote.files.keys()].some((path) => path.startsWith(`${mangaDir}/`)), "stop keeping = pack removed");
  void recoveryKey;
  console.log("  ✓ engine: novels go up alone, manga on request, budgeted, cleaned after delete");
}

console.log("sync-files-unit: all checks passed");
