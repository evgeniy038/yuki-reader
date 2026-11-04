import type { MokuroBlock } from "../mokuro";
import { folderName, sealJson, unsealJson } from "./crypto";
import type { Hlc } from "./hlc";
import type { LocalState, Shadow } from "./merge";
import { parseOcrPack, type BookKey, type DeviceInfo } from "./model";
import type { RemoteFolder } from "./remote";
import type { VaultBinding } from "./store";

// Manga OCR results travel too: a volume recognized on the Mac (WebGPU, a
// few minutes) reaches the phone as text, and the phone's OCR queue skips
// every page that is already done in storage — no second pass on a phone
// battery. Each device publishes its finished packs under its OWN folder
// (devices/<id>/ocr/<book folder>.bin); the book's `ocr` register says
// whose pack is current. A pack from an older OCR engine is never applied.

/** The app side of OCR sync. */
export interface OcrBridge {
  /** The OCR engine version of this build. */
  readonly ocrEngine: number;
  /** This device's finished OCR of a volume (every page that needs OCR is
      recognized), or null — sidecar-only volumes and unfinished ones. */
  finishedOcr(localId: string): Promise<Map<number, MokuroBlock[]> | null>;
  applyOcr(localId: string, pages: Map<number, MokuroBlock[]>): Promise<void>;
}

export const ocrPath = (deviceId: string, folder: string): string =>
  `devices/${deviceId}/ocr/${folder}.bin`;

/** One OCR pass over the manga volumes this device holds; mutates `merged`
    (its own uploads stamp the register) and `applied`. Returns bytes moved. */
export async function syncOcr(
  remote: RemoteFolder,
  vault: VaultBinding,
  device: DeviceInfo,
  bridge: OcrBridge,
  merged: Pick<Shadow, "books" | "settings">,
  local: LocalState,
  hlc: Hlc,
  applied: Record<BookKey, number>,
): Promise<number> {
  let bytes = 0;
  for (const book of local.books) {
    const regs = merged.books[book.key];
    if (book.format !== "manga" || !regs || regs.deleted?.v === true) continue;
    const current = regs.ocr && regs.ocr.v === bridge.ocrEngine ? regs.ocr : undefined;
    if (current) {
      // A current pack exists: ours (nothing to do) or another device's
      // (download once per pack).
      if (current.d === device.id || applied[book.key] === current.t) continue;
      const path = ocrPath(current.d, await folderName(vault.keys, book.key));
      const sealed = await remote.read(path);
      if (!sealed) continue;
      bytes += sealed.length;
      const pack = await unsealJson(vault.keys, vault.id, path, sealed).then(parseOcrPack, () => undefined);
      if (!pack || pack.engine !== bridge.ocrEngine) continue;
      await bridge.applyOcr(book.id, pack.pages);
      applied[book.key] = current.t;
      continue;
    }
    // No current pack anywhere: publish ours once this device has finished.
    const pages = await bridge.finishedOcr(book.id);
    if (!pages) continue;
    const path = ocrPath(device.id, await folderName(vault.keys, book.key));
    const sealed = await sealJson(vault.keys, vault.id, path, {
      v: 1,
      engine: bridge.ocrEngine,
      pages: Object.fromEntries(pages),
    });
    await remote.write(path, sealed);
    bytes += sealed.length;
    merged.books[book.key] = { ...regs, ocr: { v: bridge.ocrEngine, t: hlc.now(), d: device.id } };
  }
  return bytes;
}
