import { normalizeSeriesKey } from "./mokuro";

export type Language = "ja" | "en";
export type BookFormat = "epub" | "pdf" | "manga";

export interface Book {
  id: string;
  title: string;
  author?: string;
  language?: Language;
  format?: BookFormat;
  /** Reading progress, 0..1. */
  progress: number;
  /** Cover image as a data URL (EPUB cover when available). */
  cover?: string;
  /** Content fingerprint for duplicate-import rejection. */
  contentHash?: string;
  /** Total pages (PDF and manga; EPUB length lives in chapters). */
  pageCount?: number;
  /** Manga only: series display name + 1-based position inside it. */
  series?: string;
  volumeIndex?: number;
  addedAt: number;
  /** Last time the book was opened or read. Absent = never opened. */
  lastReadAt?: number;
}

// ---------------------------------------------------------------------------
// Shelf ordering and grouping. Pure functions — the seam the shelf UI and the
// node unit test (tests/shelf-unit.ts) both cross.

export type ShelfSort = "recent" | "title" | "author" | "added" | "progress";

// Sort ids only — the labels are UI language and live in the locales
// (library.sort.*); components map them through t().
export const SHELF_SORTS: { value: ShelfSort }[] = [
  { value: "recent" },
  { value: "title" },
  { value: "author" },
  { value: "added" },
  { value: "progress" },
];

// Recency = the last moment the book mattered: opened/read, or just added
// (a fresh unread import belongs near the top — you probably want to start it).
function recencyOf(book: Book): number {
  return Math.max(book.lastReadAt ?? 0, book.addedAt);
}

export function sortBooks(books: Book[], sort: ShelfSort): Book[] {
  const sorted = [...books];
  switch (sort) {
    case "recent":
      sorted.sort((a, b) => recencyOf(b) - recencyOf(a));
      break;
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title, "ja"));
      break;
    case "author":
      sorted.sort(
        (a, b) =>
          (a.author ?? "").localeCompare(b.author ?? "", "ja") ||
          a.title.localeCompare(b.title, "ja"),
      );
      break;
    case "added":
      sorted.sort((a, b) => b.addedAt - a.addedAt);
      break;
    case "progress":
      sorted.sort((a, b) => b.progress - a.progress);
      break;
  }
  return sorted;
}

interface ShelfGroup<T> {
  /** Section id — the label comes from the locales (native names for ja/en,
      library.other for the rest). */
  id: "ja" | "en" | "other";
  items: T[];
}

// Shelf sections by language, in reading order: Japanese first, English
// second, language-less books last. Empty sections are omitted; the caller
// renders headers only when more than one group exists.
export function groupByLanguage<T extends { language?: Language }>(
  items: T[],
): ShelfGroup<T>[] {
  const groups: ShelfGroup<T>[] = [
    { id: "ja", items: items.filter((b) => b.language === "ja") },
    { id: "en", items: items.filter((b) => b.language === "en") },
    { id: "other", items: items.filter((b) => b.language === undefined) },
  ];
  return groups.filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------
// Shelf items: manga volumes collapse into one SERIES tile (the reference
// readers group by a uuid written at OCR time — real files all carry the same
// default, so volumes scatter; we group by the derived series name instead).
// Everything else stays a plain book tile.

export type ShelfItem =
  | { kind: "book"; book: Book }
  | {
      kind: "series";
      /** Stable tile id ("series:<normalized name>") — flash target too. */
      id: string;
      /** Display name, shared by every volume. */
      series: string;
      cover?: string;
      language?: Language;
      /** Mean of the volumes' progress. */
      progress: number;
      volumeCount: number;
      addedAt: number;
      lastReadAt?: number;
    };

/** Pseudo-id of a series tile on the shelf — where duplicate flashes point. */
export function seriesShelfId(series: string): string {
  return `series:${normalizeSeriesKey(series)}`;
}

export function buildShelfItems(sortedBooks: Book[]): ShelfItem[] {
  const items: ShelfItem[] = [];
  const seriesIndex = new Map<string, number>();
  // The series cover follows the earliest volume (by number) that has one.
  const coverIndex = new Map<string, number>();
  for (const book of sortedBooks) {
    if (book.format !== "manga" || !book.series) {
      items.push({ kind: "book", book });
      continue;
    }
    const key = normalizeSeriesKey(book.series);
    const at = seriesIndex.get(key);
    if (at === undefined) {
      seriesIndex.set(key, items.length);
      if (book.cover && book.volumeIndex !== undefined) {
        coverIndex.set(key, book.volumeIndex);
      }
      items.push({
        kind: "series",
        id: seriesShelfId(book.series),
        series: book.series,
        cover: book.cover,
        language: book.language,
        progress: book.progress,
        volumeCount: 1,
        addedAt: book.addedAt,
        lastReadAt: book.lastReadAt,
      });
      continue;
    }
    const item = items[at];
    if (item === undefined || item.kind !== "series") continue;
    item.progress =
      (item.progress * item.volumeCount + book.progress) / (item.volumeCount + 1);
    item.volumeCount += 1;
    const best = coverIndex.get(key);
    if (book.cover && book.volumeIndex !== undefined && (best === undefined || book.volumeIndex < best)) {
      coverIndex.set(key, book.volumeIndex);
      item.cover = book.cover;
    } else if (item.cover === undefined && book.cover) {
      item.cover = book.cover;
    }
    item.addedAt = Math.max(item.addedAt, book.addedAt);
    item.lastReadAt = Math.max(item.lastReadAt ?? 0, book.lastReadAt ?? 0) || undefined;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Reading state shown on the tile: nothing for a fresh book, a percent while
// reading, "Finished" at the end (the label comes from the locales).

type ReadingState = "new" | "reading" | "finished";

export function readingStateOf(book: Book): ReadingState {
  if (book.progress >= 0.995) return "finished";
  if (book.progress > 0) return "reading";
  return "new";
}

// ---------------------------------------------------------------------------
// Language detection for books whose file carries no language metadata
// (PDFs, sloppy EPUBs). Kana/kanji in the sample → ja, latin → en.

const KANA_OR_KANJI = /[ぁ-ゖァ-ヺ一-龯]/;

export function detectLanguage(html: string): Language | undefined {
  const sample = html.replace(/<[^>]*>/g, " ").slice(0, 8000);
  if (KANA_OR_KANJI.test(sample)) return "ja";
  if (/[A-Za-z]/.test(sample)) return "en";
  return undefined;
}

// ---------------------------------------------------------------------------
// Shelf-sort preference (localStorage).

const SHELF_SORT_KEY = "yuki-shelf-sort";

export function loadShelfSort(): ShelfSort {
  if (typeof window === "undefined") return "recent";
  const raw = window.localStorage.getItem(SHELF_SORT_KEY);
  return SHELF_SORTS.some((s) => s.value === raw)
    ? (raw as ShelfSort)
    : "recent";
}

export function saveShelfSort(sort: ShelfSort): void {
  window.localStorage.setItem(SHELF_SORT_KEY, sort);
}

// ---------------------------------------------------------------------------
// Collapsed shelf sections (localStorage). Ids: "ja" | "en" | "other" for
// language groups, "<group>:novels" | "<group>:manga" for subsections.

const SHELF_COLLAPSED_KEY = "yuki-shelf-collapsed";

export function loadShelfCollapsed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SHELF_COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveShelfCollapsed(ids: string[]): void {
  window.localStorage.setItem(SHELF_COLLAPSED_KEY, JSON.stringify(ids));
}
