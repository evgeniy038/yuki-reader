import type { Book } from "@/core/library";
import { trackMangaOcr } from "@/core/ocr/ocr";
import { OCR_ENGINE, type BookRecord } from "@/core/storage";
import { installPack, packDir, readManifest, type PackManifest } from "@/core/sync/book-pack";
import { folderName } from "@/core/sync/crypto";
import type { BookKey, BookRegs } from "@/core/sync/model";
import { syncStore } from "@/core/sync/store";
import { currentHost, folder, getView, onRoundDone, patchView, requestSync } from "./sync-controller";

// The shelf's cloud half: books another device uploaded that this one
// doesn't hold. Novels and PDFs up to AUTO_BYTES just arrive on their own
// after a round; manga volumes and big files wait as cloud tiles until
// tapped. A downloaded manga volume can go again ("remove from this
// device") without leaving the cloud or the other devices.

const AUTO_BYTES = 25 * 1024 * 1024;
const active = new Set<BookKey>();

async function manifestOf(
  key: BookKey,
  regs: BookRegs,
  cache: Map<BookKey, { t: number; manifest: PackManifest }>,
): Promise<PackManifest | null> {
  const file = regs.file;
  if (!file || file.v === 0) return null;
  const cached = cache.get(key);
  if (cached && cached.t === file.t) return cached.manifest;
  const [remote, vault] = await Promise.all([folder(), syncStore.vault()]);
  if (!remote || !vault) return null;
  const manifest = await readManifest(remote, vault, packDir(file.d, await folderName(vault.keys, key))).catch(() => null);
  if (manifest) cache.set(key, { t: file.t, manifest });
  return manifest;
}

/** Rebuild the cloud list from the merged registers; fetch small books. */
async function refresh(): Promise<void> {
  const host = currentHost();
  const [shadow, keys] = await Promise.all([syncStore.shadow(), syncStore.bookKeys()]);
  if (!host || !shadow) return;
  const localIds = new Set(host.books().map((book) => book.id));
  const localKeys = new Set([...keys].filter(([id]) => localIds.has(id)).map(([, key]) => key));
  const cache = await syncStore.packManifests();
  const cloud: { key: BookKey; desc: PackManifest["desc"] }[] = [];
  for (const [key, regs] of Object.entries(shadow.books)) {
    if (regs.deleted?.v === true || localKeys.has(key)) continue;
    const manifest = await manifestOf(key, regs, cache);
    if (!manifest) continue;
    const desc = { ...manifest.desc, title: regs.name?.v ?? manifest.desc.title };
    if (regs.series?.v) desc.series = regs.series.v;
    if (typeof regs.volumeIndex?.v === "number") desc.volumeIndex = regs.volumeIndex.v;
    cloud.push({ key, desc });
  }
  for (const key of cache.keys()) if (!cloud.some((item) => item.key === key)) cache.delete(key);
  await syncStore.setPackManifests(cache);
  const inCloud = [...keys]
    .filter(([id, key]) => {
      const regs = shadow.books[key];
      const book = host.books().find((b) => b.id === id);
      return book?.format === "manga" && regs?.file !== undefined && regs.file.v > 0 && regs.deleted?.v !== true;
    })
    .map(([id]) => id);
  patchView({ cloud, inCloud });
  for (const item of cloud) {
    if (item.desc.format !== "manga" && item.desc.size <= AUTO_BYTES) await download(item.key).catch(() => null);
  }
}

onRoundDone(refresh);

function setProgress(key: BookKey, value: number | null): void {
  const downloads = { ...getView().downloads };
  if (value === null) delete downloads[key];
  else downloads[key] = value;
  patchView({ downloads });
}

/** Download a cloud book; resolves to its new local id (null when another
    download of it is already on the way). Throws when it can't arrive. */
export async function download(key: BookKey): Promise<string | null> {
  if (active.has(key)) return null;
  active.add(key);
  try {
    const [host, remote, vault, shadow] = await Promise.all([currentHost(), folder(), syncStore.vault(), syncStore.shadow()]);
    const regs = shadow?.books[key];
    if (!host || !remote || !vault || !regs?.file || regs.file.v === 0) throw new Error("The book is no longer in the cloud");
    const manifest = await manifestOf(key, regs, await syncStore.packManifests());
    if (!manifest) throw new Error("The book is no longer in the cloud");
    setProgress(key, 0);
    const id = crypto.randomUUID();
    const personal: Parameters<typeof installPack>[5] = { progress: regs.progress?.v ?? 0, addedAt: Date.now() };
    if (regs.lastReadAt !== undefined) personal.lastReadAt = regs.lastReadAt;
    if (regs.favorite?.v) personal.favorite = true;
    if (regs.keep?.v) personal.keepInCloud = true;
    if (regs.name?.v) personal.title = regs.name.v;
    if (regs.series?.v) personal.series = regs.series.v;
    if (typeof regs.volumeIndex?.v === "number") personal.volumeIndex = regs.volumeIndex.v;
    const dir = packDir(regs.file.d, await folderName(vault.keys, key));
    const record: BookRecord = await installPack(remote, vault, dir, manifest, id, personal, (done, total) =>
      setProgress(key, total > 0 ? done / total : 1),
    );
    const keys = await syncStore.bookKeys();
    keys.set(id, key);
    await syncStore.setBookKeys(keys);
    const { chapters: _c, toc: _t, resources: _r, bookCss: _b, pdfBytes: _p, ...book } = record;
    const shelf: Book = book;
    host.add(shelf);
    // No current OCR pack in the cloud: this device recognizes the volume
    // itself (a current one arrives with the next round instead).
    if (shelf.format === "manga" && regs.ocr?.v !== OCR_ENGINE) void trackMangaOcr(id);
    const view = getView();
    patchView({
      cloud: view.cloud.filter((item) => item.key !== key),
      inCloud: shelf.format === "manga" ? [...view.inCloud, id] : view.inCloud,
    });
    requestSync(2_000);
    return id;
  } finally {
    active.delete(key);
    setProgress(key, null);
  }
}

/** Free a manga volume's space here; it stays in the cloud and on the shelf
    of every other device (no tombstone — this device just stops holding it). */
export async function removeDownload(id: string): Promise<void> {
  const run = async () => {
    const [keys, shadow] = await Promise.all([syncStore.bookKeys(), syncStore.shadow()]);
    const key = keys.get(id);
    if (!key || !shadow) return;
    await syncStore.setShadow({ ...shadow, held: shadow.held.filter((k) => k !== key) });
    keys.delete(id);
    await syncStore.setBookKeys(keys);
    currentHost()?.remove([id]);
  };
  if (navigator.locks) await navigator.locks.request("yuki-sync", run);
  else await run();
  await refresh();
}
