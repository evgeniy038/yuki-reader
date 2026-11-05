import type { Book } from "@/core/library";
import { onOcrBooks } from "@/core/ocr/progress";
import { OCR_ENGINE, putMangaOcrRecords, type BookRecord, type MangaOcrRecord } from "@/core/storage";
import { installPack, PACK_VERSION, packDir, readManifest, type PackManifest } from "@/core/sync/book-pack";
import { holdersOf } from "@/core/sync/catalog";
import { folderName } from "@/core/sync/crypto";
import type { BookKey, BookRegs, DeviceInfo } from "@/core/sync/model";
import { readOcrPack } from "@/core/sync/ocr-sync";
import type { PersonalState } from "@/core/sync/pack-stream";
import { isReady, processingOf } from "@/core/sync/ready";
import type { RemoteFolder } from "@/core/sync/remote";
import type { VaultBinding } from "@/core/sync/store";
import { syncStore } from "@/core/sync/store";
import { fetchFromPeer, servePeers, type DirectStage } from "./p2p";
import { downloadNearby, nearbyHas, nearbyKnows } from "./sync-nearby";
import { PeerUnavailableError } from "./p2p-protocol";
import { packSourceOf } from "./sync-bridge";
import { forgetReadiness } from "./sync-ready";
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
// others' requests while it is open — from the moment the app starts, not
// after its first round (a round can take a while, or fail on its own).
// A direct request rings every device that holds the book ready.
// A book is offered only once it is fully processed on its device: a
// manga volume still being recognized there shows as a waiting tile with
// that device's progress (`preparing`) and can't be tapped yet. A volume
// arrives WITH its text — in the pack or the stream, or, for a pack from
// before that, from the volume's OCR pack right after — and this device
// never recognizes it again.

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

/** Who to ask directly for `key`: every device whose catalog lists it
    ready (not still processing it). */
async function holders(key: BookKey): Promise<DeviceInfo[]> {
  const catalogs = await syncStore.remoteCatalogs();
  return holdersOf(key, remotes().map((state) => state.device), catalogs).filter(
    (device) => catalogs.get(device.id)?.catalog.books[key]?.prep === undefined,
  );
}

/** Does a cloud pack bring the volume's text — in itself, in its sidecars,
    or in a current OCR pack next to it? */
function packHasText(manifest: PackManifest, regs: BookRegs): boolean {
  if (!manifest.manga) return true;
  if (manifest.ocr?.engine === OCR_ENGINE || regs.ocr?.v === OCR_ENGINE) return true;
  return manifest.manga.pages.every((page) => page.blocks !== undefined && page.blocks.length > 0);
}

/** Rebuild the list from the merged registers and the catalogs; fetch the
    small cloud books. */
async function refresh(): Promise<void> {
  const host = currentHost();
  const [shadow, keys, catalogs] = await Promise.all([syncStore.shadow(), syncStore.bookKeys(), syncStore.remoteCatalogs()]);
  if (!host || !shadow) return;
  const localIds = new Set(host.books().map((book) => book.id));
  const localKeys = new Set([...keys].filter(([id]) => localIds.has(id)).map(([, key]) => key));
  const cache = await syncStore.packManifests();
  const devices = remotes().map((state) => state.device);
  const cloud: SyncCloudItem[] = [];
  const titled = (key: BookKey, base: PackManifest["desc"]) => {
    const regs = shadow.books[key];
    const { prep: _prep, ...rest } = base;
    const desc = { ...rest, title: regs?.name?.v ?? base.title };
    if (regs?.series?.v) desc.series = regs.series.v;
    if (typeof regs?.volumeIndex?.v === "number") desc.volumeIndex = regs.volumeIndex.v;
    return desc;
  };
  for (const [key, regs] of Object.entries(shadow.books)) {
    if (regs.deleted?.v === true || localKeys.has(key)) continue;
    if (nearbyHas(key)) continue;
    const manifest = await manifestOf(key, regs, cache);
    if (!manifest) continue;
    // An older pack without the text, still being recognized on its device:
    // wait with that device's progress. When no device reports any, it
    // comes as it is and its text follows through sync.
    const prep = packHasText(manifest, regs) ? undefined : preparingOf(key, catalogs);
    cloud.push({ key, desc: titled(key, manifest.desc), ...(prep !== undefined ? { preparing: prep } : {}) });
  }
  for (const key of cache.keys()) if (!cloud.some((item) => item.key === key)) cache.delete(key);
  await syncStore.setPackManifests(cache);
  // Then everything another device holds that isn't in the cloud.
  for (const { catalog } of catalogs.values()) {
    for (const [key, desc] of Object.entries(catalog.books)) {
      if (localKeys.has(key) || shadow.books[key]?.deleted?.v === true) continue;
      if (cloud.some((item) => item.key === key)) continue;
      // Named after the same device a tap rings first; still processing
      // everywhere it is held: waiting, with the furthest progress.
      const listed = holdersOf(key, devices, catalogs);
      const ready = listed.filter((device) => catalogs.get(device.id)?.catalog.books[key]?.prep === undefined);
      const from = ready[0] ?? listed[0];
      const prep = ready.length > 0 ? undefined : preparingOf(key, catalogs);
      if (from) cloud.push({ key, desc: titled(key, desc), from, ...(prep !== undefined ? { preparing: prep } : {}) });
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
    if ((item.from && !nearbyHas(item.key)) || item.preparing !== undefined || item.desc.format === "manga" || item.desc.size > AUTO_BYTES) continue;
    await download(item.key).catch(() => null);
  }
}

/** The furthest progress any device's catalog reports for a book it is
    still processing; undefined when none does. */
function preparingOf(key: BookKey, catalogs: Awaited<ReturnType<typeof syncStore.remoteCatalogs>>): number | undefined {
  let best: number | undefined;
  for (const { catalog } of catalogs.values()) {
    const prep = catalog.books[key]?.prep;
    if (prep !== undefined) best = Math.max(best ?? 0, prep);
  }
  return best;
}

type SyncCloudItem = SyncView["cloud"][number];

onRoundDone(refresh);
startServing();

// A volume this device just finished recognizing is ready to be offered:
// publish it soon instead of at the next minute's round.
const recognized = new Set<string>();
onOcrBooks((books) => {
  for (const { bookId, stage } of books) {
    if (stage !== "done" || recognized.has(bookId)) continue;
    recognized.add(bookId);
    forgetReadiness(bookId);
    requestSync(2_000);
  }
});

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
    idle: () => new Promise((resolve) => setTimeout(resolve, document.visibilityState === "visible" ? 3_000 : 15_000)),
  });
}

function setProgress(key: BookKey, value: number | null): void {
  const downloads = { ...getView().downloads };
  if (value === null) delete downloads[key];
  else downloads[key] = value;
  patchView({ downloads });
}

function setStage(key: BookKey, stage: DirectStage | null): void {
  const direct = { ...getView().direct };
  if (stage) direct[key] = stage;
  else delete direct[key];
  patchView({ direct });
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
    if (!host) throw new Error("Sync is off");
    const regs = shadow?.books[key];
    const id = crypto.randomUUID();
    const personal = personalOf(regs);
    const progress = (done: number, total: number) => setProgress(key, total > 0 ? done / total : 1);
    setProgress(key, 0);
    let record: BookRecord;
    const peers = await holders(key);
    const paired = nearbyHas(key) || (!remote && peers.some((peer) => nearbyKnows(peer.id)));
    const manifest = !paired && regs ? await manifestOf(key, regs, await syncStore.packManifests()) : null;
    if (manifest && regs?.file && remote && vault) {
      record = await installPack(remote, vault, packDir(regs.file.d, await folderName(vault.keys, key)), manifest, id, personal, progress);
    } else {
      if (peers.length === 0) throw new Error("No device has this book any more");
      try {
        const options = {
          key,
          id,
          personal,
          onStage: (stage: DirectStage) => setStage(key, stage),
          onProgress: (done: number, total: number) => {
            setStage(key, null);
            progress(done, total);
          },
        };
        if (paired) record = await downloadNearby(options);
        else if (remote && vault) record = await fetchFromPeer({ ...options, remote, vault, peers: peers.map((peer) => peer.id) });
        else throw new PeerUnavailableError();
      } finally {
        setStage(key, null);
      }
    }
    const keys = await syncStore.bookKeys();
    keys.set(id, key);
    await syncStore.setBookKeys(keys);
    if (record.format === "manga" && regs && remote && vault) await withText(remote, vault, key, id, regs).catch(() => {});
    const { chapters: _c, toc: _t, resources: _r, bookCss: _b, pdfBytes: _p, ...book } = record;
    const shelf: Book = book;
    host.add(shelf);
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

/** A volume from a pack without its text (1.4.4 and older, or an older
    sender) takes it from the volume's current OCR pack before it goes on
    the shelf. Either way the next round needn't fetch that pack again. */
async function withText(remote: RemoteFolder, vault: VaultBinding, key: BookKey, id: string, regs: BookRegs): Promise<void> {
  const ocr = regs.ocr?.v === OCR_ENGINE ? regs.ocr : undefined;
  if (!ocr) return;
  if (!isReady(await processingOf(id, "manga"))) {
    const pack = await readOcrPack(remote, vault, ocr.d, key, OCR_ENGINE);
    if (!pack) return;
    const records = new Map<number, MangaOcrRecord>();
    for (const [index, blocks] of pack.pages) records.set(index, { blocks, engine: OCR_ENGINE });
    await putMangaOcrRecords(id, records);
    forgetReadiness(id);
  }
  const note = async () => {
    const applied = await syncStore.ocrApplied();
    await syncStore.setOcrApplied({ ...applied, [key]: ocr.t });
  };
  void (navigator.locks ? navigator.locks.request("yuki-sync", note) : note());
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
