import type { BookFormat } from "../library";
import type { MokuroBlock } from "../mokuro";
import { hasBookContent, loadManga, loadMangaOcr, loadMangaOcrDone, type MangaRecord } from "../storage";

// A book is offered to the other devices — listed in the catalog, uploaded
// to the cloud, served over a direct transfer — only once it is fully
// processed HERE: a novel or a PDF once its import is stored; a manga
// volume once every page has text, from its sidecar or from a finished
// in-app OCR record of the current engine. So the other devices get it
// ready-made and never recognize it a second time.

/** How far a book is from being offered. */
export interface Processing {
  /** Pages with text (a novel or a PDF: 1 of 1 once stored). */
  done: number;
  total: number;
  /** A manga volume that came from another device: it waits for that
      device's text instead of being recognized here. */
  received: boolean;
}

/** Pages that need in-app OCR: those without sidecar boxes. */
export function pagesNeedingOcr(manga: MangaRecord): number[] {
  return manga.pages.flatMap((meta, index) => (meta.blocks && meta.blocks.length > 0 ? [] : [index]));
}

export const isReady = (processing: Processing | null): boolean =>
  processing !== null && processing.done >= processing.total;

/** Where a stored book stands; null while it isn't stored (yet). */
export async function processingOf(id: string, format: BookFormat | undefined): Promise<Processing | null> {
  if (format !== "manga") return (await hasBookContent(id)) ? { done: 1, total: 1, received: false } : null;
  const manga = await loadManga(id);
  if (!manga) return null;
  const needing = pagesNeedingOcr(manga);
  const done = needing.length > 0 ? await loadMangaOcrDone(id) : new Set<number>();
  return {
    done: needing.filter((index) => done.has(index)).length,
    total: needing.length,
    received: manga.received === true,
  };
}

/** A finished volume's in-app OCR — the text that travels with it. Null
    while any page still lacks it, and for a volume that needs none. */
export async function finishedOcrPages(id: string): Promise<Map<number, MokuroBlock[]> | null> {
  const manga = await loadManga(id);
  const needing = manga ? pagesNeedingOcr(manga) : [];
  if (needing.length === 0) return null;
  const records = await loadMangaOcr(id);
  const pages = new Map<number, MokuroBlock[]>();
  for (const index of needing) {
    const record = records.get(index);
    if (!record || record.partial) return null;
    pages.set(index, record.blocks);
  }
  return pages;
}
