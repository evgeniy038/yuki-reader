import { inflateSync, strFromU8 } from "fflate";

// Lazy ZIP reading for imports: the central directory is read from the end
// of the archive, and entries are fetched only when asked for, through a
// sliding 16MB window — a few big reads, never one per entry (a File read
// is a round-trip to the browser process: per-entry reads measured ~4x
// slower than unzipSync on a 199-page zip). A STORED entry becomes a slice
// of the archive itself: a disk-backed Blob, not a byte copied. A deflated
// one is inflated on its own. So a 250MB volume never sits in memory whole
// (unzipSync held the archive plus a copy of every entry — ~3x its size).
// Read entries in offset order (byOffset) to keep the window sliding
// forward. Names decode like fflate's (UTF-8 when the archive flags it,
// latin1 otherwise), so page names, their order and sidecar matching stay
// exactly what they were.

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;

async function bytesAt(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

const u16 = (d: Uint8Array, at: number) => d[at]! | (d[at + 1]! << 8);
const u32 = (d: Uint8Array, at: number) =>
  (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24)) >>> 0;
const u64 = (d: Uint8Array, at: number) => u32(d, at) + u32(d, at + 4) * 2 ** 32;

/** Every entry of the archive, by name, in central-directory order (a
    repeated name keeps its first place and its last entry, like the object
    unzipSync returns). */
async function readZipEntries(file: Blob): Promise<Map<string, ZipEntry>> {
  // The end record sits in the last 22 bytes + up to a 64KB comment.
  const tailStart = Math.max(0, file.size - 22 - 0xffff - 20);
  const tail = await bytesAt(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive (no end of central directory)");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === MAX_U32 || cdSize === MAX_U32 || count === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(tail, locator) !== ZIP64_LOCATOR) {
      throw new Error("Broken zip64 archive");
    }
    const record = u64(tail, locator + 8);
    const z64 = await bytesAt(file, record, record + 56);
    if (u32(z64, 0) !== ZIP64_EOCD) throw new Error("Broken zip64 archive");
    count = u64(z64, 32);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  const cd = await bytesAt(file, cdOffset, cdOffset + cdSize);
  const entries = new Map<string, ZipEntry>();
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (u32(cd, at) !== CENTRAL) throw new Error("Broken zip central directory");
    const flags = u16(cd, at + 8);
    const method = u16(cd, at + 10);
    let compressedSize = u32(cd, at + 20);
    let size = u32(cd, at + 24);
    const nameLength = u16(cd, at + 28);
    const extraLength = u16(cd, at + 30);
    const commentLength = u16(cd, at + 32);
    let offset = u32(cd, at + 42);
    const name = strFromU8(
      cd.subarray(at + 46, at + 46 + nameLength),
      !(flags & 2048),
    );
    // zip64 extra field: the 64-bit values, in this order, for the fields
    // that overflowed.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = u16(cd, extra);
      const length = u16(cd, extra + 2);
      if (id === 1) {
        let field = extra + 4;
        if (size === MAX_U32) {
          size = u64(cd, field);
          field += 8;
        }
        if (compressedSize === MAX_U32) {
          compressedSize = u64(cd, field);
          field += 8;
        }
        if (offset === MAX_U32) offset = u64(cd, field);
      }
      extra += 4 + length;
    }
    entries.set(name, { name, method, compressedSize, size, offset });
    at = extraEnd + commentLength;
  }
  return entries;
}

const WINDOW = 16 * 1024 * 1024;

/** An archive opened for reading: its entries plus readers for them. */
export interface ZipArchive {
  entries: Map<string, ZipEntry>;
  /** The entry as a Blob: a slice of the archive when stored, the inflated
      bytes when deflated. */
  blob(entry: ZipEntry, type: string): Promise<Blob>;
  /** The entry's bytes (decompressed, a copy of its own). */
  bytes(entry: ZipEntry): Promise<Uint8Array>;
}

export async function openZip(file: Blob): Promise<ZipArchive> {
  const entries = await readZipEntries(file);
  let windowStart = 0;
  let window: Uint8Array = new Uint8Array(0);
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    if (start < windowStart || end > windowStart + window.length) {
      windowStart = start;
      const windowEnd = Math.min(file.size, Math.max(end, start + WINDOW));
      window = await bytesAt(file, start, windowEnd);
    }
    return window.subarray(start - windowStart, end - windowStart);
  };
  // Past the local header (whose extra field may differ from the central one).
  const dataStart = async (entry: ZipEntry): Promise<number> => {
    const header = await read(entry.offset, entry.offset + 30);
    if (u32(header, 0) !== LOCAL) throw new Error(`Broken zip entry ${entry.name}`);
    return entry.offset + 30 + u16(header, 26) + u16(header, 28);
  };
  const inflate = async (entry: ZipEntry, start: number): Promise<Uint8Array> => {
    if (entry.method !== 8) {
      throw new Error(`Unsupported zip compression ${entry.method} (${entry.name})`);
    }
    const compressed = await read(start, start + entry.compressedSize);
    return inflateSync(compressed, { out: new Uint8Array(entry.size) });
  };
  return {
    entries,
    async blob(entry, type) {
      const start = await dataStart(entry);
      if (entry.method === 0) return file.slice(start, start + entry.size, type);
      return new Blob([(await inflate(entry, start)) as BlobPart], { type });
    },
    async bytes(entry) {
      const start = await dataStart(entry);
      if (entry.method === 0) return (await read(start, start + entry.size)).slice();
      return inflate(entry, start);
    },
  };
}

/** Names sorted by where their entries sit in the archive. */
export function byOffset(entries: Map<string, ZipEntry>, names: string[]): string[] {
  return [...names].sort(
    (a, b) => (entries.get(a)?.offset ?? 0) - (entries.get(b)?.offset ?? 0),
  );
}
