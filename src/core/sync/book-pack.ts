import type { BookFormat, Language } from "../library";
import type { MangaStoredPage } from "../import-manga";
import { toBlock, type MokuroBlock } from "../mokuro";
import type { Chapter, EpubResource, TocEntry } from "../reading";
import {
  deleteBook,
  putBook,
  putMangaPageBlob,
  putMangaRecord,
  type BookRecord,
  type MangaRecord,
} from "../storage";
import { seal, sealJson, unseal, unsealJson } from "./crypto";
import type { RemoteFolder } from "./remote";
import type { VaultBinding } from "./store";

// A book's own files in the cloud — the "pack". Same pieces as a backup
// (the record, EPUB resources, the PDF, manga pages), each one sealed and
// cut into 4 MiB parts so an upload or a download that breaks off resumes
// from the part it stopped at, and a phone never holds a whole 300 MB
// volume in memory. The manifest goes up LAST: no manifest = not uploaded
// (yet). A pack lives under the uploading device's own folder:
//   devices/<device>/books/<folder>/manifest.bin   PackManifest (small: a tile's worth)
//   devices/<device>/books/<folder>/<file>.<part>.bin
// File 0 is always the record (chapters, TOC, CSS — JSON).

export const PACK_VERSION = 1;
export const PART_BYTES = 4 * 1024 * 1024;

export const packDir = (deviceId: string, folder: string): string =>
  `devices/${deviceId}/books/${folder}`;
export const manifestPath = (dir: string): string => `${dir}/manifest.bin`;
export const partPath = (dir: string, file: number, part: number): string =>
  `${dir}/${file}.${part}.bin`;

/** What a cloud tile shows before anything heavy downloads. */
export interface PackDesc {
  title: string;
  author?: string;
  language?: Language;
  format: BookFormat;
  cover?: string;
  pageCount?: number;
  series?: string;
  volumeIndex?: number;
  /** Bytes of the book itself, all files together. */
  size: number;
}

export interface PackManifest {
  v: 1;
  desc: PackDesc;
  files: { size: number; parts: number; mime?: string }[];
  resources: { path: string; mime: string; file: number }[];
  pdf?: number;
  manga?: { pages: MangaStoredPage[]; files: number[] };
}

/** The book without its bulk: file 0 of the pack. Personal state (position,
    pin, "keep in cloud") travels in the registers, never here. */
type PackedRecord = Omit<
  BookRecord,
  "resources" | "pdfBytes" | "progress" | "lastReadAt" | "favorite" | "keepInCloud"
>;

/** What the device lends a pack: the stored book (and its manga pages). */
export interface PackSource {
  record: BookRecord;
  manga?: { record: MangaRecord; page: (index: number) => Promise<Blob | undefined> };
}

export interface PlannedPack {
  manifest: PackManifest;
  read: (file: number) => Promise<Uint8Array>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const parts = (size: number): number => Math.max(1, Math.ceil(size / PART_BYTES));

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
  const files: PackManifest["files"] = [{ size: recordBytes.length, parts: parts(recordBytes.length) }];
  const add = (size: number, read: () => Promise<Uint8Array>, mime?: string): number => {
    files.push({ size, parts: parts(size), ...(mime ? { mime } : {}) });
    readers.push(read);
    return files.length - 1;
  };
  const manifest: PackManifest = {
    v: 1,
    desc: { title: rest.title, format: rest.format ?? (pdfBytes ? "pdf" : "epub"), size: 0 },
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
  desc.size = files.reduce((sum, file) => sum + file.size, 0);
  return { manifest, read: (file) => readers[file]!() };
}

/** Upload what isn't in the cloud yet, manifest last. Stops between parts
    once `deadline` passes; `done` = the manifest is up. */
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
  for (const [file, meta] of plan.manifest.files.entries()) {
    let data: Uint8Array | null = null;
    for (let part = 0; part < meta.parts; part += 1) {
      const path = partPath(dir, file, part);
      if (existing.has(path)) continue;
      if (Date.now() > deadline) return { done: false, bytes };
      data ??= await plan.read(file);
      const sealed = await seal(vault.keys, vault.id, path, data.subarray(part * PART_BYTES, (part + 1) * PART_BYTES));
      await remote.write(path, sealed);
      bytes += sealed.length;
    }
  }
  const path = manifestPath(dir);
  const sealed = await sealJson(vault.keys, vault.id, path, plan.manifest);
  await remote.write(path, sealed);
  return { done: true, bytes: bytes + sealed.length };
}

/** The pack's manifest, or null (not uploaded, unreadable, wrong shape). */
export async function readManifest(
  remote: RemoteFolder,
  vault: VaultBinding,
  dir: string,
): Promise<PackManifest | null> {
  const path = manifestPath(dir);
  const sealed = await remote.read(path);
  if (!sealed) return null;
  return unsealJson(vault.keys, vault.id, path, sealed).then(parsePackManifest, () => null);
}

/** One file of a pack, parts joined; throws when a part is missing. */
async function readFile(
  remote: RemoteFolder,
  vault: VaultBinding,
  dir: string,
  file: number,
  meta: PackManifest["files"][number],
): Promise<Uint8Array> {
  const out = new Uint8Array(meta.size);
  let offset = 0;
  for (let part = 0; part < meta.parts; part += 1) {
    const path = partPath(dir, file, part);
    const sealed = await remote.read(path);
    if (!sealed) throw new Error(`A part of the book is missing in the cloud: ${path}`);
    const plain = await unseal(vault.keys, vault.id, path, sealed);
    if (offset + plain.length > meta.size) throw new Error("A part of the book is damaged");
    out.set(plain, offset);
    offset += plain.length;
  }
  if (offset !== meta.size) throw new Error("A part of the book is damaged");
  return out;
}

/** Download a pack and store it as book `id`; returns the stored record's
    shelf half. Manga pages land one by one; anything that fails takes the
    half-written book back out. `progress` gets bytes done / total. */
export async function installPack(
  remote: RemoteFolder,
  vault: VaultBinding,
  dir: string,
  manifest: PackManifest,
  id: string,
  /** This device's view of the book: position, pin, name, series… */
  personal: Pick<BookRecord, "progress" | "addedAt"> &
    Partial<Pick<BookRecord, "lastReadAt" | "favorite" | "keepInCloud" | "title" | "series" | "volumeIndex">>,
  progress?: (done: number, total: number) => void,
): Promise<BookRecord> {
  const total = manifest.desc.size;
  let done = 0;
  const get = async (file: number): Promise<Uint8Array> => {
    const meta = manifest.files[file];
    if (!meta) throw new Error("A book file is missing from its pack");
    const bytes = await readFile(remote, vault, dir, file, meta);
    done += bytes.length;
    progress?.(done, total);
    return bytes;
  };
  try {
    const packed = parsePackedRecord(JSON.parse(decoder.decode(await get(0))) as unknown);
    if (!packed) throw new Error("The book record in the cloud is damaged");
    const resources: EpubResource[] = [];
    for (const ref of manifest.resources) {
      resources.push({ path: ref.path, mime: ref.mime, bytes: await get(ref.file) });
    }
    const record: BookRecord = { ...packed, ...personal, id, resources };
    if (manifest.pdf !== undefined) record.pdfBytes = await get(manifest.pdf);
    if (manifest.manga) {
      for (const [index, file] of manifest.manga.files.entries()) {
        const mime = manifest.files[file]?.mime ?? "application/octet-stream";
        await putMangaPageBlob(id, index, new Blob([(await get(file)) as BlobPart], { type: mime }));
      }
      await putMangaRecord({ id, pages: manifest.manga.pages });
    }
    await putBook(record);
    return record;
  } catch (error) {
    await deleteBook(id);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shape checks (trust boundary): the bytes were sealed by one of the user's
// own devices, but a newer build's pack or a damaged one must never become a
// half-broken book.

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isIndex = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const FORMATS: readonly BookFormat[] = ["epub", "pdf", "manga"];
const LANGUAGES: readonly Language[] = ["ja", "en"];

function parseDesc(v: unknown): PackDesc | undefined {
  if (!isObject(v) || !isStr(v.title) || !isNum(v.size)) return undefined;
  const format = FORMATS.find((f) => f === v.format);
  if (!format) return undefined;
  const desc: PackDesc = { title: v.title, format, size: v.size };
  if (isStr(v.author)) desc.author = v.author;
  const language = LANGUAGES.find((l) => l === v.language);
  if (language) desc.language = language;
  if (isStr(v.cover)) desc.cover = v.cover;
  if (isNum(v.pageCount)) desc.pageCount = v.pageCount;
  if (isStr(v.series)) desc.series = v.series;
  if (isNum(v.volumeIndex)) desc.volumeIndex = v.volumeIndex;
  return desc;
}

function parsePage(v: unknown): MangaStoredPage | undefined {
  if (!isObject(v) || !isStr(v.path)) return undefined;
  const page: MangaStoredPage = { path: v.path };
  if (isNum(v.img_width)) page.img_width = v.img_width;
  if (isNum(v.img_height)) page.img_height = v.img_height;
  if (Array.isArray(v.blocks)) page.blocks = v.blocks.map(toBlock).filter((b): b is MokuroBlock => b !== null);
  return page;
}

export function parsePackManifest(v: unknown): PackManifest | null {
  if (!isObject(v) || v.v !== 1 || !Array.isArray(v.files) || !Array.isArray(v.resources)) return null;
  const desc = parseDesc(v.desc);
  if (!desc) return null;
  const files: PackManifest["files"] = [];
  for (const f of v.files) {
    if (!isObject(f) || !isIndex(f.size) || !isIndex(f.parts) || f.parts < 1) return null;
    files.push({ size: f.size, parts: f.parts, ...(isStr(f.mime) ? { mime: f.mime } : {}) });
  }
  const known = (file: unknown): file is number => isIndex(file) && file < files.length;
  const resources: PackManifest["resources"] = [];
  for (const r of v.resources) {
    if (!isObject(r) || !isStr(r.path) || !isStr(r.mime) || !known(r.file)) return null;
    resources.push({ path: r.path, mime: r.mime, file: r.file });
  }
  const manifest: PackManifest = { v: 1, desc, files, resources };
  if (v.pdf !== undefined) {
    if (!known(v.pdf)) return null;
    manifest.pdf = v.pdf;
  }
  if (v.manga !== undefined) {
    if (!isObject(v.manga) || !Array.isArray(v.manga.pages) || !Array.isArray(v.manga.files)) return null;
    const pages = v.manga.pages.map(parsePage);
    const pageFiles = v.manga.files;
    if (pages.some((p) => !p) || pageFiles.length !== pages.length || !pageFiles.every(known)) return null;
    manifest.manga = { pages: pages.filter((p): p is MangaStoredPage => p !== undefined), files: pageFiles.filter(known) };
  }
  return files.length > 0 ? manifest : null;
}

function parseChapter(v: unknown): Chapter | undefined {
  if (!isObject(v) || !isStr(v.id) || !isStr(v.html)) return undefined;
  return { id: v.id, html: v.html, ...(isStr(v.title) ? { title: v.title } : {}) };
}

function parseToc(v: unknown): TocEntry | undefined {
  if (!isObject(v) || !isStr(v.label) || !isStr(v.chapterId)) return undefined;
  return { label: v.label, chapterId: v.chapterId };
}

/** File 0 back into a record (without personal state and bulk). */
export function parsePackedRecord(v: unknown): PackedRecord | null {
  if (!isObject(v) || !isStr(v.title) || !isNum(v.addedAt) || !Array.isArray(v.chapters)) return null;
  const chapters = v.chapters.map(parseChapter);
  if (chapters.some((c) => !c)) return null;
  const record: PackedRecord = {
    id: isStr(v.id) ? v.id : "",
    title: v.title,
    addedAt: v.addedAt,
    chapters: chapters.filter((c): c is Chapter => c !== undefined),
  };
  if (isStr(v.author)) record.author = v.author;
  const language = LANGUAGES.find((l) => l === v.language);
  if (language) record.language = language;
  const format = FORMATS.find((f) => f === v.format);
  if (format) record.format = format;
  if (isStr(v.cover)) record.cover = v.cover;
  if (isStr(v.contentHash)) record.contentHash = v.contentHash;
  if (isNum(v.pageCount)) record.pageCount = v.pageCount;
  if (isStr(v.series)) record.series = v.series;
  if (isNum(v.volumeIndex)) record.volumeIndex = v.volumeIndex;
  if (isStr(v.bookCss)) record.bookCss = v.bookCss;
  if (Array.isArray(v.toc)) record.toc = v.toc.map(parseToc).filter((e): e is TocEntry => e !== undefined);
  return record;
}
