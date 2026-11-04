import type { MokuroBlock } from "../mokuro";
import type { MangaStoredPage } from "../import-manga";
import { MANGA, MANGA_OCR, MANGA_PAGES, OCR_MODELS, open } from "./db";

/** Manga volume sidecar record: page metadata in reading order. The page
    images themselves live in the pages store (`${id}/${index}` → Blob), so
    progress saves never rewrite megabytes of scans. */
export interface MangaRecord {
  id: string;
  pages: MangaStoredPage[];
}

/** In-app OCR result for one manga page (the app-generated counterpart of a
    .mokuro sidecar page). Keyed `${bookId}/${pageIndex}` like the page blobs. */
export interface MangaOcrRecord {
  blocks: MokuroBlock[];
  /** Pipeline version — a bump re-runs OCR for pages stored by an older one. */
  engine: number;
  /** Detect-only skeletons (lazy OCR): boxes/vertical/font_size are final,
      lines are empty until recognized — on hover, in the reading window, or
      by the background catch-up pass. */
  partial?: boolean;
  /** Exact float detector rects ([x1,y1,x2,y2], aligned with `blocks`;
      `blocks[].box` stays rounded for the overlay) so recognition reuses
      the detector's crops. Absent on legacy records — full detect then. */
  crops?: number[][];
}

/** Cached OCR model file (downloaded once, reused forever). */
export interface OcrModelRecord {
  url: string;
  bytes: Uint8Array;
}

/** Key range covering every key with the given prefix. */
export function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

// --- Manga volumes ---------------------------------------------------------

/** Persist a volume: metadata record plus every page blob, atomically. */
export async function putMangaVolume(
  record: MangaRecord,
  blobs: Blob[],
): Promise<void> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_PAGES], "readwrite");
  const pages = tx.objectStore(MANGA_PAGES);
  // Every put is issued at once and the transaction awaited once: no
  // round-trip per page between requests.
  await Promise.all([
    tx.objectStore(MANGA).put(record),
    ...blobs.map((blob, i) => pages.put(blob, `${record.id}/${i}`)),
    tx.done,
  ]);
}

/** One page blob on its own — a download lands a volume page by page, so a
    300 MB volume never sits in a phone's memory whole. The record goes
    last (putMangaRecord): until then the volume doesn't exist. */
export async function putMangaPageBlob(id: string, index: number, blob: Blob): Promise<void> {
  const db = await open();
  await db.put(MANGA_PAGES, blob, `${id}/${index}`);
}

export async function putMangaRecord(record: MangaRecord): Promise<void> {
  const db = await open();
  await db.put(MANGA, record);
}

export async function loadManga(id: string): Promise<MangaRecord | undefined> {
  const db = await open();
  return db.get(MANGA, id);
}

export async function loadMangaPageBlob(
  id: string,
  index: number,
): Promise<Blob | undefined> {
  const db = await open();
  return db.get(MANGA_PAGES, `${id}/${index}`);
}

/** Drop a volume's metadata, every page blob and its OCR results (id is a
    book id). */
export async function deleteManga(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_PAGES, MANGA_OCR], "readwrite");
  await tx.objectStore(MANGA).delete(id);
  const range = prefixRange(`${id}/`);
  for (const storeName of [MANGA_PAGES, MANGA_OCR] as const) {
    let cursor = await tx.objectStore(storeName).openCursor(range);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

// --- In-app manga OCR --------------------------------------------------------

/** Current OCR pipeline version. Results stored with an older engine are
    treated as missing and re-run. 2 = decoder runaway guard, 3 = lazy OCR
    (detect-only skeleton records + KV-cache merged decoder), 4 = full 43MB
    detector (measured 2x better CER), 5 = antialiased resampling (detector
    threshold recalibrated for it), grayscale crops and line-by-line reads
    of dense blocks. */
export const OCR_ENGINE = 5;

// OCR writes are atomic at the storage boundary: every write opens the manga
// store in the SAME readwrite transaction as the OCR store, serializing with
// deleteManga — a deleted volume can never be resurrected by a late worker
// result (the write sees the manga row gone and skips). A detect skeleton
// never downgrades a final record; a block fill merges inside the
// transaction so concurrent fills of different blocks never clobber.

/** Detect skeleton: final boxes, empty lines, plus the exact float crop
    rects (`crops`, aligned with `blocks`) so the recognition march reuses
    them without a second detector pass. Returns false when the volume is
    gone or the page already holds a final record (never downgrade it). */
export async function putMangaOcrDetect(
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
  crops: number[][],
): Promise<boolean> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  const manga = await tx.objectStore(MANGA).get(bookId);
  const store = tx.objectStore(MANGA_OCR);
  const key = `${bookId}/${pageIndex}`;
  const existing: MangaOcrRecord | undefined = manga
    ? await store.get(key)
    : undefined;
  if (!manga || (existing?.engine === OCR_ENGINE && !existing.partial)) {
    await tx.done;
    return false;
  }
  await store.put({ blocks, crops, engine: OCR_ENGINE, partial: true }, key);
  await tx.done;
  return true;
}

/** Final recognition result for a page. Returns false when the volume is
    gone (deleted/cancelled mid-flight — the result is dropped, not written). */
export async function putMangaOcrFinal(
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
): Promise<boolean> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  const manga = await tx.objectStore(MANGA).get(bookId);
  if (!manga) {
    await tx.done;
    return false;
  }
  await tx
    .objectStore(MANGA_OCR)
    .put({ blocks, engine: OCR_ENGINE }, `${bookId}/${pageIndex}`);
  await tx.done;
  return true;
}

/** Fill ONE block of a skeleton record (hover lazy-OCR), atomically merging
    into the current record so concurrent fills are never lost. No-op once
    the page is final or the volume is gone. Returns the stored record (the
    unchanged one when it was already final), or null when there is nothing
    to fill. */
export async function mergeMangaOcrBlock(
  bookId: string,
  pageIndex: number,
  blockIndex: number,
  block: MokuroBlock,
): Promise<MangaOcrRecord | null> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  const manga = await tx.objectStore(MANGA).get(bookId);
  const store = tx.objectStore(MANGA_OCR);
  const key = `${bookId}/${pageIndex}`;
  const existing: MangaOcrRecord | undefined = manga
    ? await store.get(key)
    : undefined;
  if (!existing || existing.engine !== OCR_ENGINE) {
    await tx.done;
    return null;
  }
  if (!existing.partial || blockIndex < 0 || blockIndex >= existing.blocks.length) {
    await tx.done;
    return existing;
  }
  const blocks = existing.blocks.slice();
  blocks[blockIndex] = block;
  const done = blocks.every((b) => b.lines.length > 0);
  const record: MangaOcrRecord = {
    blocks,
    engine: OCR_ENGINE,
    ...(existing.crops ? { crops: existing.crops } : {}),
    ...(done ? {} : { partial: true }),
  };
  await store.put(record, key);
  await tx.done;
  return record;
}

/** One page's OCR record (blocks + partial flag), or undefined when not
    computed yet (or stale). */
export async function loadMangaOcrPage(
  bookId: string,
  pageIndex: number,
): Promise<MangaOcrRecord | undefined> {
  const db = await open();
  const record = await db.get(MANGA_OCR, `${bookId}/${pageIndex}`);
  return record?.engine === OCR_ENGINE ? record : undefined;
}

/** All OCR'd pages of a volume: page index → record (blocks + partial flag). */
export async function loadMangaOcr(
  bookId: string,
): Promise<Map<number, MangaOcrRecord>> {
  const db = await open();
  const range = prefixRange(`${bookId}/`);
  const [keys, records] = await Promise.all([
    db.getAllKeys(MANGA_OCR, range),
    db.getAll(MANGA_OCR, range),
  ]);
  const out = new Map<number, MangaOcrRecord>();
  keys.forEach((key, i) => {
    const record = records[i];
    if (record?.engine !== OCR_ENGINE) return;
    const index = Number(key.slice(key.lastIndexOf("/") + 1));
    if (Number.isFinite(index)) out.set(index, record);
  });
  return out;
}

/** OCR progress flags for a volume: page index → fully recognized. This is
    what the queue panel counts — re-read after every completed page, so the
    UI always shows storage truth. */
export async function loadMangaOcrFlags(
  bookId: string,
): Promise<Map<number, boolean>> {
  const records = await loadMangaOcr(bookId);
  const out = new Map<number, boolean>();
  for (const [index, record] of records) out.set(index, !record.partial);
  return out;
}

/** Cached OCR model file; undefined when not downloaded yet. */
export async function loadOcrModel(url: string): Promise<Uint8Array | undefined> {
  const db = await open();
  return (await db.get(OCR_MODELS, url))?.bytes;
}

/** Whether a model file is cached — a key lookup, the bytes stay on disk. */
export async function hasOcrModel(url: string): Promise<boolean> {
  const db = await open();
  return (await db.getKey(OCR_MODELS, url)) !== undefined;
}

export async function putOcrModel(url: string, bytes: Uint8Array): Promise<void> {
  const db = await open();
  await db.put(OCR_MODELS, { url, bytes });
}

export async function putMangaOcrRecords(
  bookId: string,
  records: Map<number, MangaOcrRecord>,
): Promise<void> {
  const db = await open();
  const tx = db.transaction([MANGA, MANGA_OCR], "readwrite");
  if (!(await tx.objectStore(MANGA).get(bookId))) {
    await tx.done;
    return;
  }
  const store = tx.objectStore(MANGA_OCR);
  for (const [pageIndex, record] of records) {
    await store.put(
      { ...record, engine: OCR_ENGINE },
      `${bookId}/${pageIndex}`,
    );
  }
  await tx.done;
}
