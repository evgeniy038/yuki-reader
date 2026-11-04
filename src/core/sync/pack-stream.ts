import type { EpubResource } from "../reading";
import { deleteBook, putBook, putMangaPageBlob, putMangaRecord, type BookRecord } from "../storage";
import type { PlannedPack } from "./book-pack";
import { parsePackedRecord, type PackManifest, type PackedRecord } from "./pack-shape";

// A pack as a byte STREAM — every file back to back, in manifest order —
// and the two ends of it, shared by the cloud (sealed 8 MiB chunks) and by
// a direct device-to-device transfer (frames over a WebRTC data channel):
//   streamPack — reads the stored book and hands out the stream in frames;
//   createInstaller — takes the stream in pieces of any size, stores every
//     file the moment it is complete (manga pages straight into storage, so
//     a 300 MB volume never sits in a phone's memory whole) and commits the
//     book at the end; abort takes a half-written book back out.

/** A pack that can't be put back together — retrying won't help. */
export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

/** This device's view of a book it receives: position, pin, name, series… */
export type PersonalState = Pick<BookRecord, "progress" | "addedAt"> &
  Partial<Pick<BookRecord, "lastReadAt" | "favorite" | "keepInCloud" | "title" | "series" | "volumeIndex">>;

const decoder = new TextDecoder();

/** Send a planned pack's stream in frames of at most `frame` bytes. */
export async function streamPack(
  plan: PlannedPack,
  frame: number,
  send: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  for (let file = 0; file < plan.manifest.files.length; file += 1) {
    const bytes = await plan.read(file);
    if (bytes.length !== plan.manifest.files[file]!.size) throw new PackError("A book file changed while it was sent");
    for (let at = 0; at < bytes.length; at += frame) await send(bytes.subarray(at, at + frame));
  }
}

export interface Installer {
  /** The next piece of the stream, any size. */
  push(bytes: Uint8Array): Promise<void>;
  /** Bytes received so far. */
  readonly received: number;
  /** Store the book once the whole stream is in; throws if it isn't. */
  finish(): Promise<BookRecord>;
  /** Take whatever was written back out. */
  abort(): Promise<void>;
}

export function createInstaller(manifest: PackManifest, id: string, personal: PersonalState): Installer {
  const resourceOf = new Map(manifest.resources.map((ref) => [ref.file, ref]));
  const pageOf = new Map((manifest.manga?.files ?? []).map((file, index) => [file, index]));
  const got: { record: PackedRecord | null; resources: EpubResource[]; pdf?: Uint8Array } = {
    record: null,
    resources: [],
  };
  let file = 0;
  let buffer = new Uint8Array(manifest.files[0]?.size ?? 0);
  let filled = 0;
  let received = 0;

  const completed = async (index: number, bytes: Uint8Array) => {
    if (index === 0) {
      got.record = parsePackedRecord(JSON.parse(decoder.decode(bytes)) as unknown);
      if (!got.record) throw new PackError("The book record is damaged");
      return;
    }
    const resource = resourceOf.get(index);
    if (resource) got.resources.push({ path: resource.path, mime: resource.mime, bytes });
    if (index === manifest.pdf) got.pdf = bytes;
    const page = pageOf.get(index);
    if (page !== undefined) {
      const mime = manifest.files[index]?.mime ?? "application/octet-stream";
      await putMangaPageBlob(id, page, new Blob([bytes as BlobPart], { type: mime }));
    }
  };

  // Files of zero bytes complete without any input.
  const drainEmpty = async () => {
    while (file < manifest.files.length && buffer.length === 0) {
      await completed(file, buffer);
      file += 1;
      buffer = new Uint8Array(manifest.files[file]?.size ?? 0);
    }
  };

  return {
    get received() {
      return received;
    },
    async push(bytes) {
      if (received + bytes.length > manifest.size) throw new PackError("More bytes than the book has");
      received += bytes.length;
      let cursor = 0;
      await drainEmpty();
      while (cursor < bytes.length && file < manifest.files.length) {
        const take = Math.min(buffer.length - filled, bytes.length - cursor);
        buffer.set(bytes.subarray(cursor, cursor + take), filled);
        filled += take;
        cursor += take;
        if (filled < buffer.length) break;
        await completed(file, buffer);
        file += 1;
        buffer = new Uint8Array(manifest.files[file]?.size ?? 0);
        filled = 0;
        await drainEmpty();
      }
    },
    async finish() {
      await drainEmpty();
      if (!got.record || file < manifest.files.length || received !== manifest.size) {
        throw new PackError("The book arrived incomplete");
      }
      const record: BookRecord = { ...got.record, ...personal, id, resources: got.resources };
      if (got.pdf) record.pdfBytes = got.pdf;
      if (manifest.manga) await putMangaRecord({ id, pages: manifest.manga.pages });
      await putBook(record);
      return record;
    },
    abort: () => deleteBook(id),
  };
}
