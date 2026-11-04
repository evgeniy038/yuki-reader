import type { Book } from "@/core/library";
import { trackMangaOcr } from "@/core/ocr/ocr";
import { OCR_ENGINE, type BookRecord } from "@/core/storage";
import { installPack, PACK_VERSION, packDir, readManifest, type PackManifest } from "@/core/sync/book-pack";
import { folderName } from "@/core/sync/crypto";
import type { BookKey, BookRegs, DeviceInfo } from "@/core/sync/model";
import type { PersonalState } from "@/core/sync/pack-stream";
import type { RemoteFolder } from "@/core/sync/remote";
import { syncStore } from "@/core/sync/store";
import { fetchFromPeer, servePeers } from "./p2p";
import { packSourceOf } from "./sync-bridge";
import { currentHost, device, folder, getView, onRoundDone, patchView, remotes, requestSync, type SyncView } from "./sync-controller";

// The shelf's other half: books this device doesn't hold but another one
// does. Two ways in:
//   - the CLOUD: packs another device uploaded (every novel and PDF, manga
//     kept in the cloud). Novels and PDFs up to AUTO_BYTES arrive on their
//     own after a round; the rest wait as tiles;
//   - DIRECTLY from the device that has the book (p2p.ts), for everything
//     its catalog lists that never went to the cloud — manga above all. A
//     tap rings the other device through the cloud and the book comes over
//     the home Wi-Fi; both have yuki open meanwhile.
// A tap prefers the cloud when the pack is there (always reachable). A
// downloaded volume can go again ("remove from this device") without
// leaving the cloud or the other devices. Every syncing device answers the
// others' requests while it is open.

const AUTO_BYTES = 25 * 1024 * 1024;
const active = new Set<BookKey>();
let stopServing: (() => void) | null = null;

async function manifestOf(
  key: BookKey,
  regs: BookRegs,
  cache: Map<BookKey, { t: number; manifest: PackManifest }>,
): Promise<PackManifest | null> {
  const file = regs.file;
  // Only the current format; an older pack is re-uploaded by its holder.
  if (!file || file.v !== PACK_VERSION) return null;
  const cached = cache.get(key);
  if (cached && cached.t === file.t) return cached.manifest;
  const [remote, vault] = await Promise.all([folder(), syncStore.vault()]);
  if (!remote || !vault) return null;
  const manifest = await readManifest(remote, vault, packDir(file.d, await folderName(vault.keys, key))).catch(() => null);
  if (manifest) cache.set(key, { t: file.t, manifest });
  return manifest;
}

/** Who to ask directly for `key`: a device whose catalog lists it. */
async function holderOf(key: BookKey): Promise<DeviceInfo | undefined> {
  const catalogs = await syncStore.remoteCatalogs();
  return remotes().find((state) => catalogs.get(state.device.id)?.catalog.books[key])?.device;
}

/** Rebuild the list from the merged registers and the catalogs; fetch the
    small cloud books. */
async function refresh(): Promise<void> {
  const host = currentHost();
  const [shadow, keys, catalogs] = await Promise.all([syncStore.shadow(), syncStore.bookKeys(), syncStore.remoteCatalogs()]);
  if (!host || !shadow) return;
  startServing();
  const localIds = new Set(host.books().map((book) => book.id));
  const localKeys = new Set([...keys].filter(([id]) => localIds.has(id)).map(([, key]) => key));
  const cache = await syncStore.packManifests();
  const devices = new Map(remotes().map((state) => [state.device.id, state.device]));
  const cloud: SyncCloudItem[] = [];
  const titled = (key: BookKey, base: PackManifest["desc"]) => {
    const regs = shadow.books[key];
    const desc = { ...base, title: regs?.name?.v ?? base.title };
    if (regs?.series?.v) desc.series = regs.series.v;
    if (typeof regs?.volumeIndex?.v === "number") desc.volumeIndex = regs.volumeIndex.v;
    return desc;
  };
  for (const [key, regs] of Object.entries(shadow.books)) {
    if (regs.deleted?.v === true || localKeys.has(key)) continue;
    const manifest = await manifestOf(key, regs, cache);
    if (manifest) cloud.push({ key, desc: titled(key, manifest.desc) });
  }
  for (const key of cache.keys()) if (!cloud.some((item) => item.key === key)) cache.delete(key);
  await syncStore.setPackManifests(cache);
  // Then everything another device holds that isn't in the cloud.
  for (const [deviceId, { catalog }] of catalogs) {
    const from = devices.get(deviceId);
    if (!from) continue;
    for (const [key, desc] of Object.entries(catalog.books)) {
      if (localKeys.has(key) || shadow.books[key]?.deleted?.v === true) continue;
      if (cloud.some((item) => item.key === key)) continue;
      cloud.push({ key, desc: titled(key, desc), from });
    }
  }
  // A volume another device (or the cloud) also holds can leave this one.
  const elsewhere = new Set([...catalogs.values()].flatMap(({ catalog }) => Object.keys(catalog.books)));
  const inCloud = [...keys]
    .filter(([id, key]) => {
      const regs = shadow.books[key];
      const book = host.books().find((b) => b.id === id);
      const held = regs?.file?.v === PACK_VERSION || elsewhere.has(key);
      return book?.format === "manga" && held && regs?.deleted?.v !== true;
    })
    .map(([id]) => id);
  patchView({ cloud, inCloud });
  for (const item of cloud) {
    if (!item.from && item.desc.format !== "manga" && item.desc.size <= AUTO_BYTES) await download(item.key).catch(() => null);
  }
}

type SyncCloudItem = SyncView["cloud"][number];

onRoundDone(refresh);

/** Answer the other devices' requests while this page is open. */
function startServing(): void {
  if (stopServing) return;
  stopServing = servePeers({
    remote: folder,
    vault: () => syncStore.vault(),
    me: async () => (await device()).id,
    packSource: async (key) => {
      const host = currentHost();
      const id = [...(await syncStore.bookKeys())].find(([localId, k]) => k === key && host?.books().some((b) => b.id === localId))?.[0];
      return host && id ? packSourceOf(host, id) : null;
    },
    wake: (remote: RemoteFolder, signal: AbortSignal) =>
      remote.watch
        ? remote.watch("signal", signal)
        : new Promise((resolve) => setTimeout(resolve, document.visibilityState === "visible" ? 3_000 : 15_000)),
  });
}

function setProgress(key: BookKey, value: number | null): void {
  const downloads = { ...getView().downloads };
  if (value === null) delete downloads[key];
  else downloads[key] = value;
  patchView({ downloads });
}

function setWaiting(key: BookKey, on: boolean): void {
  const waiting = { ...getView().waiting };
  if (on) waiting[key] = true;
  else delete waiting[key];
  patchView({ waiting });
}

function personalOf(regs: BookRegs | undefined): PersonalState {
  const personal: PersonalState = { progress: regs?.progress?.v ?? 0, addedAt: Date.now() };
  if (!regs) return personal;
  if (regs.lastReadAt !== undefined) personal.lastReadAt = regs.lastReadAt;
  if (regs.favorite?.v) personal.favorite = true;
  if (regs.keep?.v) personal.keepInCloud = true;
  if (regs.name?.v) personal.title = regs.name.v;
  if (regs.series?.v) personal.series = regs.series.v;
  if (typeof regs.volumeIndex?.v === "number") personal.volumeIndex = regs.volumeIndex.v;
  return personal;
}

/** Fetch a book this device doesn't hold — from the cloud when its pack is
    there, otherwise straight from a device that has it. Resolves to its new
    local id (null when it's already on the way); throws when it can't come. */
export async function download(key: BookKey): Promise<string | null> {
  if (active.has(key)) return null;
  active.add(key);
  try {
    const [host, remote, vault, shadow] = await Promise.all([currentHost(), folder(), syncStore.vault(), syncStore.shadow()]);
    if (!host || !remote || !vault) throw new Error("Sync is off");
    const regs = shadow?.books[key];
    const id = crypto.randomUUID();
    const personal = personalOf(regs);
    const progress = (done: number, total: number) => setProgress(key, total > 0 ? done / total : 1);
    setProgress(key, 0);
    let record: BookRecord;
    const manifest = regs ? await manifestOf(key, regs, await syncStore.packManifests()) : null;
    if (manifest && regs?.file) {
      record = await installPack(remote, vault, packDir(regs.file.d, await folderName(vault.keys, key)), manifest, id, personal, progress);
    } else {
      const holder = await holderOf(key);
      if (!holder) throw new Error("No device has this book any more");
      try {
        record = await fetchFromPeer({
          remote,
          vault,
          me: (await device()).id,
          peer: holder.id,
          key,
          id,
          personal,
          onWaiting: () => setWaiting(key, true),
          onProgress: (done, total) => {
            setWaiting(key, false);
            progress(done, total);
          },
        });
      } finally {
        setWaiting(key, false);
      }
    }
    const keys = await syncStore.bookKeys();
    keys.set(id, key);
    await syncStore.setBookKeys(keys);
    const { chapters: _c, toc: _t, resources: _r, bookCss: _b, pdfBytes: _p, ...book } = record;
    const shelf: Book = book;
    host.add(shelf);
    // No current OCR pack in the cloud: this device recognizes the volume
    // itself (a current one arrives with the next round instead).
    if (shelf.format === "manga" && regs?.ocr?.v !== OCR_ENGINE) void trackMangaOcr(id);
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
