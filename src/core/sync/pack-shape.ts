import type { BookFormat, Language } from "../library";
import type { MangaStoredPage } from "../import-manga";
import { toBlock, type MokuroBlock } from "../mokuro";
import type { Chapter, TocEntry } from "../reading";
import type { BookRecord } from "../storage";

// The shape of a book pack (book-pack.ts): what the manifest promises and
// the checks that hold it to that at the trust boundary.

/** The pack is one stream — every file back to back — cut into sealed
    chunks of this size (the last one shorter). 8 MiB: a few dozen requests
    for a 300 MB volume, and three in flight stay small in a phone's memory. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

export const chunkCount = (size: number): number => Math.max(1, Math.ceil(size / CHUNK_BYTES));

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
  /** Catalog only: still being processed on its device — the share of
      pages done, 0..1. Not offered until it's ready. */
  prep?: number;
}

export interface PackManifest {
  v: 2;
  desc: PackDesc;
  /** Bytes in the stream (= desc.size). */
  size: number;
  chunks: number;
  /** Where each file sits in the stream. File 0 is the record. */
  files: { offset: number; size: number; mime?: string }[];
  resources: { path: string; mime: string; file: number }[];
  pdf?: number;
  manga?: { pages: MangaStoredPage[]; files: number[] };
  /** The volume's in-app OCR as one file, and the engine that made it. */
  ocr?: { file: number; engine: number };
}

/** The book without its bulk: file 0 of the pack. Personal state (position,
    pin, "keep in cloud") travels in the registers, never here. */
export type PackedRecord = Omit<
  BookRecord,
  "resources" | "pdfBytes" | "progress" | "lastReadAt" | "favorite" | "keepInCloud"
>;

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

export function parseDesc(v: unknown): PackDesc | undefined {
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
  if (isNum(v.prep) && v.prep >= 0 && v.prep <= 1) desc.prep = v.prep;
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
  if (!isObject(v) || v.v !== 2 || !Array.isArray(v.files) || !Array.isArray(v.resources)) return null;
  const desc = parseDesc(v.desc);
  if (!desc) return null;
  if (!isIndex(v.size) || !isIndex(v.chunks)) return null;
  const files: PackManifest["files"] = [];
  let offset = 0;
  for (const f of v.files) {
    // One stream, every file right after the previous one.
    if (!isObject(f) || f.offset !== offset || !isIndex(f.size)) return null;
    files.push({ offset, size: f.size, ...(isStr(f.mime) ? { mime: f.mime } : {}) });
    offset += f.size;
  }
  if (offset !== v.size || v.chunks !== chunkCount(v.size)) return null;
  const known = (file: unknown): file is number => isIndex(file) && file < files.length;
  const resources: PackManifest["resources"] = [];
  for (const r of v.resources) {
    if (!isObject(r) || !isStr(r.path) || !isStr(r.mime) || !known(r.file)) return null;
    resources.push({ path: r.path, mime: r.mime, file: r.file });
  }
  const manifest: PackManifest = { v: 2, desc, size: v.size, chunks: v.chunks, files, resources };
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
  if (v.ocr !== undefined) {
    if (!isObject(v.ocr) || !known(v.ocr.file) || !isIndex(v.ocr.engine)) return null;
    manifest.ocr = { file: v.ocr.file, engine: v.ocr.engine };
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
