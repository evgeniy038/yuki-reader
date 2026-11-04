import { folderName } from "./crypto";
import type { Hlc } from "./hlc";
import type { LocalState, Shadow } from "./merge";
import type { BookKey, DeviceInfo } from "./model";
import { PACK_VERSION, packDir, planPack, uploadPack, type PackSource } from "./book-pack";
import { QuotaError, type RemoteFolder } from "./remote";
import type { VaultBinding } from "./store";

// The books themselves follow the reading state: a book on one device
// appears on the others. Each device uploads the packs of the books it
// holds under its OWN folder, and the book's `file` register names whose
// pack is current — so a book is uploaded once, by whoever had it first.
// EPUB and PDF always go up; a manga volume only when "keep in the cloud"
// is on for it (`keep`) — a volume is hundreds of MB and free clouds hold
// 2–5 GB. Uploads are cut into parts and run on a time budget per round,
// so a long upload never holds the reading state back: the next round
// carries on from the part it stopped at. A book deleted everywhere, or a
// volume taken out of the cloud, has its pack removed by its uploader.

/** The app side of file sync. */
export interface FileBridge {
  /** The stored book (and its manga pages), or null when unavailable. */
  packSource(localId: string): Promise<PackSource | null>;
}

export interface FilesReport {
  bytes: number;
  /** An upload is still on its way (budget ran out) — run again soon. */
  pending: boolean;
  /** The cloud is out of space: uploads stopped, reading sync goes on. */
  full: boolean;
}

/** Should this book's files be in the cloud? */
export function wantsCloud(format: string | undefined, keep: boolean | undefined): boolean {
  return format !== "manga" || keep === true;
}

/** One file pass; mutates `merged` (stamps `file` for finished uploads and
    removals). Never throws for a full cloud — reports it instead. */
export async function syncFiles(
  remote: RemoteFolder,
  vault: VaultBinding,
  device: DeviceInfo,
  bridge: FileBridge,
  merged: Pick<Shadow, "books" | "settings">,
  local: LocalState,
  hlc: Hlc,
  deadline: number,
): Promise<FilesReport> {
  const report: FilesReport = { bytes: 0, pending: false, full: false };
  const mine = new Map<string, Set<string>>();
  for (const entry of await remote.list(`devices/${device.id}/books`)) {
    const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
    const set = mine.get(dir) ?? new Set<string>();
    set.add(entry.path);
    mine.set(dir, set);
  }
  const stamp = (key: BookKey, v: number) => {
    const regs = merged.books[key];
    if (regs) merged.books[key] = { ...regs, file: { v, t: hlc.now(), d: device.id } };
  };
  const removePack = async (dir: string) => {
    for (const path of mine.get(dir) ?? []) await remote.remove(path);
    mine.delete(dir);
  };

  // Packs this device uploaded that nobody should keep any more.
  for (const [key, regs] of Object.entries(merged.books)) {
    if (!regs.file || regs.file.v === 0 || regs.file.d !== device.id) continue;
    const gone = regs.deleted?.v === true;
    if (!gone && wantsCloud(regs.format, regs.keep?.v)) continue;
    await removePack(packDir(device.id, await folderName(vault.keys, key)));
    stamp(key, 0);
  }

  for (const book of local.books) {
    const regs = merged.books[book.key];
    if (!regs || regs.deleted?.v === true) continue;
    if (!wantsCloud(book.format, regs.keep?.v ?? book.keep)) continue;
    if (regs.file && regs.file.v > 0) continue;
    if (Date.now() > deadline) {
      report.pending = true;
      break;
    }
    const source = await bridge.packSource(book.id);
    const plan = source ? await planPack(source) : null;
    if (!plan) continue;
    const dir = packDir(device.id, await folderName(vault.keys, book.key));
    try {
      const sent = await uploadPack(remote, vault, dir, plan, mine.get(dir) ?? new Set(), deadline);
      report.bytes += sent.bytes;
      if (sent.done) stamp(book.key, PACK_VERSION);
      else {
        report.pending = true;
        break;
      }
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error;
      report.full = true;
      break;
    }
  }
  return report;
}
