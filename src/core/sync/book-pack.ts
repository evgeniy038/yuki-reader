import type { BookRecord, MangaRecord } from "../storage";
import { seal, sealJson, unseal, unsealJson } from "./crypto";
import { CHUNK_BYTES, chunkCount, parsePackManifest, type PackManifest } from "./pack-shape";
import { createInstaller, PackError, type PersonalState } from "./pack-stream";
import { AuthRequiredError, QuotaError, type RemoteFolder } from "./remote";
import type { VaultBinding } from "./store";

export { CHUNK_BYTES, parsePackManifest, type PackDesc, type PackManifest } from "./pack-shape";
export { PackError, type PersonalState } from "./pack-stream";

// A book's own files in the cloud — the "pack". The same pieces as a backup
// (the record, EPUB resources, the PDF, manga pages) laid back to back as
// ONE stream and cut into sealed 8 MiB chunks: a 300 MB volume is a few
// dozen requests, not one per page (each request costs ~0.5–0.9 s to the
// cloud through a VPN before a byte moves). Chunks go three at a time each
// way, transient failures retry, an upload that breaks off resumes from the
// chunks already up, and the manifest goes LAST: no manifest = not uploaded
// (yet). A pack lives in the uploading device's own folder OUTSIDE
// devices/ — the reading-state round lists devices/ every minute and must
// never wade through book chunks:
//   books/<device>/<folder>/manifest.bin   PackManifest (small: a tile's worth)
//   books/<device>/<folder>/<n>.bin        chunk n
// Scans and PDFs are sealed without compression (they don't shrink).

/** Pack format v2 (v1, 1.4.0: one cloud file per book file, inside
    devices/ — superseded; files.ts removes those). */
export const PACK_VERSION = 2;
/** Requests in flight per transfer. */
export const TRANSFERS = 3;

export const packDir = (deviceId: string, folder: string): string => `books/${deviceId}/${folder}`;
/** Where 1.4.0 kept this device's v1 packs. */
export const legacyPacksDir = (deviceId: string): string => `devices/${deviceId}/books`;
export const manifestPath = (dir: string): string => `${dir}/manifest.bin`;
export const chunkPath = (dir: string, chunk: number): string => `${dir}/${chunk}.bin`;

/** What the device lends a pack: the stored book (and its manga pages). */
export interface PackSource {
  record: BookRecord;
  manga?: { record: MangaRecord; page: (index: number) => Promise<Blob | undefined> };
}

export interface PlannedPack {
  manifest: PackManifest;
  read: (file: number) => Promise<Uint8Array>;
  /** Deflate the chunks (EPUB text); scans and PDFs are stored as is. */
  compress: boolean;
}


const encoder = new TextEncoder();

/** Lay a stored book out as a pack; null when a manga page is missing. */
export async function planPack(source: PackSource): Promise<PlannedPack | null> {
  const {
    resources = [],
    pdfBytes,
    progress: _progress,
    lastReadAt: _lastReadAt,
    favorite: _favorite,
    keepInCloud: _keep,
    ...rest
  } = source.record;
  const recordBytes = encoder.encode(JSON.stringify(rest));
  const readers: (() => Promise<Uint8Array>)[] = [async () => recordBytes];
  const files: PackManifest["files"] = [{ offset: 0, size: recordBytes.length }];
  let size = recordBytes.length;
  const add = (bytes: number, read: () => Promise<Uint8Array>, mime?: string): number => {
    files.push({ offset: size, size: bytes, ...(mime ? { mime } : {}) });
    size += bytes;
    readers.push(read);
    return files.length - 1;
  };
  const format = rest.format ?? (pdfBytes ? "pdf" : "epub");
  const manifest: PackManifest = {
    v: 2,
    desc: { title: rest.title, format, size: 0 },
    size: 0,
    chunks: 0,
    files,
    resources: resources.map((resource) => ({
      path: resource.path,
      mime: resource.mime,
      file: add(resource.bytes.length, async () => resource.bytes),
    })),
  };
  if (pdfBytes) manifest.pdf = add(pdfBytes.length, async () => pdfBytes);
  if (source.manga) {
    const { record, page } = source.manga;
    const pageFiles: number[] = [];
    for (let index = 0; index < record.pages.length; index += 1) {
      const blob = await page(index);
      if (!blob) return null;
      pageFiles.push(add(blob.size, async () => new Uint8Array(await blob.arrayBuffer()), blob.type || undefined));
    }
    manifest.manga = { pages: record.pages, files: pageFiles };
  }
  const desc = manifest.desc;
  if (rest.author) desc.author = rest.author;
  if (rest.language) desc.language = rest.language;
  if (rest.cover) desc.cover = rest.cover;
  if (rest.pageCount !== undefined) desc.pageCount = rest.pageCount;
  if (rest.series) desc.series = rest.series;
  if (rest.volumeIndex !== undefined) desc.volumeIndex = rest.volumeIndex;
  desc.size = size;
  manifest.size = size;
  manifest.chunks = chunkCount(size);
  // A big PDF or resource spans many chunks: keep the last file read.
  let last: { file: number; bytes: Promise<Uint8Array> } | null = null;
  const read = (file: number): Promise<Uint8Array> => {
    if (last?.file !== file) last = { file, bytes: readers[file]!() };
    return last.bytes;
  };
  return { manifest, read, compress: format === "epub" };
}

/** Transient failures (a dropped connection, a 429, a 5xx) get a few more
    tries with a growing pause; a full cloud, a lost sign-in or a broken
    pack fail at once. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const final = error instanceof QuotaError || error instanceof AuthRequiredError || error instanceof PackError;
      if (final || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

/** Run `count` jobs, TRANSFERS at a time; the first failure stops it all. */
async function pool(count: number, job: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const lane = async () => {
    while (failed === null && next < count) {
      const index = next;
      next += 1;
      try {
        await job(index);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRANSFERS, count) }, lane));
  if (failed !== null) throw failed;
}

/** Chunk n of the stream: the slice of every file it overlaps. */
async function buildChunk(plan: PlannedPack, chunk: number): Promise<Uint8Array> {
  const start = chunk * CHUNK_BYTES;
  const end = Math.min(start + CHUNK_BYTES, plan.manifest.size);
  const out = new Uint8Array(end - start);
  for (const [file, meta] of plan.manifest.files.entries()) {
    const from = Math.max(start, meta.offset);
    const to = Math.min(end, meta.offset + meta.size);
    if (from >= to) continue;
    const bytes = await plan.read(file);
    out.set(bytes.subarray(from - meta.offset, to - meta.offset), from - start);
  }
  return out;
}

/** Upload the chunks that aren't in the cloud yet, then the manifest. Stops
    taking new chunks once `deadline` passes; `done` = the manifest is up. */
export async function uploadPack(
  remote: RemoteFolder,
  vault: VaultBinding,
  dir: string,
  plan: PlannedPack,
  existing: ReadonlySet<string>,
  deadline: number,
): Promise<{ done: boolean; bytes: number }> {
  let bytes = 0;
  if (existing.has(manifestPath(dir))) return { done: true, bytes };
  let stopped = false;
  await pool(plan.manifest.chunks, async (chunk) => {
    const path = chunkPath(dir, chunk);
    if (existing.has(path)) return;
    if (Date.now() > deadline) {
      stopped = true;
      return;
    }
    const sealed = await seal(vault.keys, vault.id, path, await buildChunk(plan, chunk), plan.compress);
    await withRetry(() => remote.write(path, sealed));
    bytes += sealed.length;
  });
  if (stopped) return { done: false, bytes };
  const path = manifestPath(dir);
  const sealed = await sealJson(vault.keys, vault.id, path, plan.manifest);
  await withRetry(() => remote.write(path, sealed));
  return { done: true, bytes: bytes + sealed.length };
}

/** The pack's manifest, or null (not uploaded, unreadable, wrong shape). */
export async function readManifest(
  remote: RemoteFolder,
  vault: VaultBinding,
  dir: string,
): Promise<PackManifest | null> {
  const path = manifestPath(dir);
  const sealed = await withRetry(() => remote.read(path));
  if (!sealed) return null;
  return unsealJson(vault.keys, vault.id, path, sealed).then(parsePackManifest, () => null);
}

/** Download a pack and store it as book `id`; returns the stored record.
    Chunks come TRANSFERS at a time but are consumed in order (see
    pack-stream.ts: every file is stored the moment it is complete).
    Anything that fails takes the half-written book back out. `progress`
    gets bytes done / total. */
export async function installPack(
  remote: RemoteFolder,
  vault: VaultBinding,
  dir: string,
  manifest: PackManifest,
  id: string,
  personal: PersonalState,
  progress?: (done: number, total: number) => void,
): Promise<BookRecord> {
  const fetchChunk = (chunk: number) =>
    withRetry(async () => {
      const path = chunkPath(dir, chunk);
      const sealed = await remote.read(path);
      if (!sealed) throw new PackError(`A part of the book is missing in the cloud: ${path}`);
      return unseal(vault.keys, vault.id, path, sealed).catch(() => {
        throw new PackError("A part of the book is damaged");
      });
    });
  const pending = new Map<number, Promise<Uint8Array>>();
  const ahead = (chunk: number) => {
    if (chunk >= manifest.chunks || pending.has(chunk)) return;
    const request = fetchChunk(chunk);
    request.catch(() => {}); // awaited in order below; never "unhandled" meanwhile
    pending.set(chunk, request);
  };
  const installer = createInstaller(manifest, id, personal);
  try {
    for (let chunk = 0; chunk < manifest.chunks; chunk += 1) {
      for (let k = chunk; k < chunk + TRANSFERS; k += 1) ahead(k);
      const bytes = await pending.get(chunk)!;
      pending.delete(chunk);
      if (bytes.length !== Math.min(CHUNK_BYTES, manifest.size - chunk * CHUNK_BYTES)) {
        throw new PackError("A part of the book is damaged");
      }
      await installer.push(bytes);
      progress?.(installer.received, manifest.size);
    }
    return await installer.finish();
  } catch (error) {
    await installer.abort();
    throw error;
  }
}
