import type { Book } from "@/core/library";
import { loadManga, loadMangaPageBlob } from "@/core/storage";
import type { PackDesc } from "@/core/sync/pack-shape";
import type { BookKey } from "@/core/sync/model";
import { isReady } from "@/core/sync/ready";
import { readinessOf } from "./sync-ready";

// This device's catalog for the others (core/sync/catalog.ts): one tile's
// worth per held book — a small cover and, for a manga volume, the size it
// would take to send. Worked out once per book and kept for the session;
// the catalog itself is rebuilt each round from the cache, which is cheap.
// Never by loading a book: a stored page blob knows its size without being
// read, but a novel's or a PDF's size means its whole content in memory —
// every book on every start, which is what got a phone's page killed. Those
// go to the cloud anyway; their tile simply shows no size (0).
// Only what is fully processed here is offered (core/sync/ready.ts): a
// volume still being recognized is listed with `prep` — how far it got —
// so the others show it waiting, not downloadable; one that came from
// another device and still waits for that device's text isn't listed at
// all (its own device lists it).

const THUMB_PX = 200;
const cache = new Map<string, PackDesc>();

async function thumbnail(cover: string | undefined): Promise<string | undefined> {
  if (!cover || typeof OffscreenCanvas === "undefined") return cover;
  try {
    const bitmap = await createImageBitmap(await (await fetch(cover)).blob());
    const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("no data url")));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

async function sizeOf(book: Book): Promise<number> {
  if (book.format !== "manga") return 0;
  const manga = await loadManga(book.id);
  let total = 0;
  for (let index = 0; index < (manga?.pages.length ?? 0); index += 1) {
    total += (await loadMangaPageBlob(book.id, index))?.size ?? 0;
  }
  return total;
}

async function descOf(book: Book): Promise<PackDesc> {
  const cached = cache.get(book.id);
  if (cached && cached.title === book.title && cached.series === book.series && cached.volumeIndex === book.volumeIndex) {
    return cached;
  }
  const desc: PackDesc = {
    ...(cached ?? { size: await sizeOf(book) }),
    title: book.title,
    format: book.format ?? "epub",
  };
  if (book.author) desc.author = book.author;
  if (book.language) desc.language = book.language;
  if (book.pageCount !== undefined) desc.pageCount = book.pageCount;
  if (book.series) desc.series = book.series;
  else delete desc.series;
  if (book.volumeIndex !== undefined) desc.volumeIndex = book.volumeIndex;
  else delete desc.volumeIndex;
  if (!cached) {
    const thumb = await thumbnail(book.cover);
    if (thumb) desc.cover = thumb;
  }
  cache.set(book.id, desc);
  return desc;
}

/** The catalog: every held book with a content key, as a tile. */
export async function catalogOf(
  books: readonly Book[],
  keyOf: (id: string) => BookKey | undefined,
): Promise<Record<BookKey, PackDesc>> {
  const out: Record<BookKey, PackDesc> = {};
  for (const book of books) {
    const key = keyOf(book.id);
    if (!key) continue;
    const processing = await readinessOf(book.id, book.format);
    if (!processing) continue;
    if (isReady(processing)) out[key] = await descOf(book);
    else if (!processing.received) {
      // Two decimals: the catalog is rewritten only when it changes.
      out[key] = { ...(await descOf(book)), prep: Math.floor((processing.done / processing.total) * 100) / 100 };
    }
  }
  return out;
}
