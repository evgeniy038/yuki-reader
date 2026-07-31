export type Language = "ja" | "en";
export type BookFormat = "epub" | "pdf";

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
  /** Total pages (PDF only; EPUB length lives in chapters). */
  pageCount?: number;
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

interface ShelfGroup {
  /** Section id — the label comes from the locales (native names for ja/en,
      library.other for the rest). */
  id: "ja" | "en" | "other";
  books: Book[];
}

// Shelf sections by language, in reading order: Japanese first, English
// second, language-less books last. Empty sections are omitted; the caller
// renders headers only when more than one group exists.
export function groupByLanguage(books: Book[]): ShelfGroup[] {
  const groups: ShelfGroup[] = [
    { id: "ja", books: books.filter((b) => b.language === "ja") },
    { id: "en", books: books.filter((b) => b.language === "en") },
    { id: "other", books: books.filter((b) => b.language === undefined) },
  ];
  return groups.filter((group) => group.books.length > 0);
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
