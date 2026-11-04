import { parseDesc, type PackDesc } from "./pack-shape";
import type { BookKey } from "./model";

// A device's CATALOG: the books it holds right now, each with what a tile
// needs (title, series, size, a small cover). Other devices read it to
// offer "on Mac" tiles for books that never went to the cloud — those come
// straight from the device that has them (p2p). One sealed file per device,
// rewritten only when its shelf changes:
//   devices/<device>/catalog.bin

export interface Catalog {
  v: 1;
  books: Record<BookKey, PackDesc>;
}

export const catalogPath = (deviceId: string): string => `devices/${deviceId}/catalog.bin`;
export const CATALOG = /^devices\/([^/]+)\/catalog\.bin$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseCatalog(value: unknown): Catalog | undefined {
  if (!isObject(value) || value.v !== 1) return undefined;
  const listed = value.books;
  if (!isObject(listed)) return undefined;
  const books: Record<BookKey, PackDesc> = {};
  for (const [key, raw] of Object.entries(listed)) {
    const desc = parseDesc(raw);
    if (desc) books[key] = desc;
  }
  return { v: 1, books };
}
