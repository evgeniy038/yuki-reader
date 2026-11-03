import { importBookFile, type ImportedBookFile } from "./import-book";
import {
  importMangaItems,
  type ImportedMangaVolume,
  type MangaInputItem,
} from "./import-manga";

// Import worker: EPUB parsing and manga archive unpacking (zip directory,
// inflate, cover, fingerprint) run here, never on the UI thread — a 100MB
// volume used to freeze the shelf for a second. One job per message; the
// pool and the in-process fallback live in import-client.ts. Page images
// travel back as Blob handles (no copy), EPUB resources by transfer.

export type ImportWorkerIn =
  | { type: "book"; id: number; file: File }
  | { type: "manga"; id: number; items: MangaInputItem[] };

export type ImportWorkerOut =
  | { type: "book"; id: number; result: ImportedBookFile }
  | { type: "manga"; id: number; volumes: ImportedMangaVolume[] }
  | { type: "error"; id: number; message: string };

const post = (msg: ImportWorkerOut, transfer: Transferable[] = []): void => {
  (
    self as unknown as {
      postMessage(msg: ImportWorkerOut, transfer: Transferable[]): void;
    }
  ).postMessage(msg, transfer);
};

/** Buffers safe to transfer: each resource owns its whole buffer. */
function resourceBuffers(result: ImportedBookFile): Transferable[] {
  if (result.kind !== "book") return [];
  const buffers = new Set<ArrayBuffer>();
  for (const { bytes } of result.resources) {
    const buffer = bytes.buffer;
    if (
      buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === buffer.byteLength
    ) {
      buffers.add(buffer);
    }
  }
  return [...buffers];
}

self.onmessage = async (event: MessageEvent<ImportWorkerIn>) => {
  const msg = event.data;
  try {
    if (msg.type === "book") {
      const result = await importBookFile(msg.file);
      post({ type: "book", id: msg.id, result }, resourceBuffers(result));
    } else {
      const volumes = await importMangaItems(msg.items);
      post({ type: "manga", id: msg.id, volumes });
    }
  } catch (err) {
    post({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
