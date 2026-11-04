import {
  loadShelfGroupOrder,
  loadShelfSort,
  saveShelfGroupOrder,
  saveShelfSort,
  SHELF_SORTS,
} from "../library";
import {
  clampFontWeight,
  FONT_OPTIONS,
  loadReadingSettings,
  saveReadingSettings,
  THEME_SEGMENTS,
  type ReadingSettings,
} from "../reading-settings";
import { loadDailyGoal, saveDailyGoal } from "../stats";
import { loadAllBooks, loadManga, loadMangaPageBlob } from "../storage";
import { epubKey, mangaKey, pdfKey, samplePage, type PageSample } from "./book-key";
import type { BookKey } from "./model";

// The bridge between the sync registers and yuki's own storage: which
// settings travel (and how they are read and written back), and the
// one-time content-key computation for each book.
//
// Synced: taste — interface language, reading theme, font, weight, furigana,
// the manga cover option, the daily goal, shelf sort and section order.
// NOT synced, on purpose: font size, line height and margins (a phone and a
// Mac need different ones), folded shelf sections (UI state), the OCR
// backend choice (hardware).

export const SYNCED_SETTINGS = [
  "lang",
  "reading.fontFamily",
  "reading.fontWeight",
  "reading.furigana",
  "reading.theme",
  "reading.mangaFirstPageAsCover",
  "reading.pageTurnAnimation",
  "goal",
  "shelf.sort",
  "shelf.groupOrder",
] as const;

type ReadingField = "fontFamily" | "fontWeight" | "furigana" | "theme" | "mangaFirstPageAsCover" | "pageTurnAnimation";
const READING_FIELDS: readonly ReadingField[] = [
  "fontFamily",
  "fontWeight",
  "furigana",
  "theme",
  "mangaFirstPageAsCover",
  "pageTurnAnimation",
];

function storedLang(): "en" | "ru" | undefined {
  try {
    const raw = localStorage.getItem("yuki-lang") ?? "";
    return raw.startsWith("ru") ? "ru" : raw.startsWith("en") ? "en" : undefined;
  } catch {
    return undefined;
  }
}

/** Current values of the synced settings, as JSON text per register. */
export function readSyncedSettings(
  keyOf: (localId: string) => BookKey | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const lang = storedLang();
  if (lang) out.lang = JSON.stringify(lang);
  const reading = loadReadingSettings();
  for (const field of READING_FIELDS) out[`reading.${field}`] = JSON.stringify(reading[field]);
  const goal = loadDailyGoal();
  out.goal = JSON.stringify({
    mode: goal.mode,
    chars: goal.chars,
    percent: goal.percent,
    book: goal.bookId === undefined ? null : (keyOf(goal.bookId) ?? null),
  });
  out["shelf.sort"] = JSON.stringify(loadShelfSort());
  out["shelf.groupOrder"] = JSON.stringify(loadShelfGroupOrder());
  return out;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface AppliedSettings {
  reading: boolean;
  goal: boolean;
  shelf: boolean;
  lang?: "en" | "ru";
}

/** One reading field from a remote value — validated like the loader does
    (unknown font or theme ids are refused, the weight is clamped). */
function withReadingField(
  reading: ReadingSettings,
  field: ReadingField,
  value: unknown,
): ReadingSettings | null {
  switch (field) {
    case "fontFamily": {
      const font = FONT_OPTIONS.find((option) => option.value === value)?.value;
      return font ? { ...reading, fontFamily: font } : null;
    }
    case "theme": {
      const theme = THEME_SEGMENTS.find((segment) => segment.value === value)?.value;
      return theme ? { ...reading, theme } : null;
    }
    case "fontWeight":
      return typeof value === "number" ? { ...reading, fontWeight: clampFontWeight(value) } : null;
    case "furigana":
      return typeof value === "boolean" ? { ...reading, furigana: value } : null;
    case "mangaFirstPageAsCover":
      return typeof value === "boolean" ? { ...reading, mangaFirstPageAsCover: value } : null;
    case "pageTurnAnimation":
      return typeof value === "boolean" ? { ...reading, pageTurnAnimation: value } : null;
  }
}

/** Write merged values back through the settings' own save functions.
    Wrong-shaped values are ignored. */
export function writeSyncedSettings(
  changes: Record<string, string>,
  localIdOf: (key: BookKey) => string | undefined,
): AppliedSettings {
  const applied: AppliedSettings = { reading: false, goal: false, shelf: false };
  let reading: ReadingSettings | null = null;
  for (const [key, text] of Object.entries(changes)) {
    const value = parse(text);
    const field = READING_FIELDS.find((f) => `reading.${f}` === key);
    if (key === "lang" && (value === "en" || value === "ru")) {
      applied.lang = value;
    } else if (field) {
      const next = withReadingField(reading ?? loadReadingSettings(), field, value);
      if (next) reading = next;
    } else if (key === "goal" && isObject(value)) {
      const { mode, chars, percent, book } = value;
      if ((mode !== "chars" && mode !== "percent") || typeof chars !== "number" || typeof percent !== "number") continue;
      const bookId = typeof book === "string" ? localIdOf(book) : undefined;
      saveDailyGoal({ mode, chars, percent, ...(bookId ? { bookId } : {}) });
      applied.goal = true;
    } else if (key === "shelf.sort") {
      const sort = SHELF_SORTS.find((s) => s.value === value)?.value;
      if (sort) {
        saveShelfSort(sort);
        applied.shelf = true;
      }
    } else if (key === "shelf.groupOrder" && Array.isArray(value)) {
      saveShelfGroupOrder(value.filter((v): v is string => typeof v === "string"));
      applied.shelf = true;
    }
  }
  if (reading) {
    saveReadingSettings(reading);
    applied.reading = true;
  }
  return applied;
}

/** Content keys for books that don't have one yet. Reads the full records
    once (chapters, PDF bytes, manga page heads) — only for missing ids. */
export async function computeBookKeys(
  ids: readonly string[],
  known: Map<string, BookKey>,
): Promise<Map<string, BookKey>> {
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length === 0) return known;
  const next = new Map(known);
  const wanted = new Set(missing);
  for (const record of await loadAllBooks()) {
    if (!wanted.has(record.id)) continue;
    if (record.format === "manga") {
      const manga = await loadManga(record.id);
      if (!manga || manga.pages.length === 0) continue;
      const samples: PageSample[] = [];
      for (let index = 0; index < manga.pages.length; index += 1) {
        const blob = await loadMangaPageBlob(record.id, index);
        if (!blob) break;
        samples.push(await samplePage(blob));
      }
      if (samples.length === manga.pages.length) next.set(record.id, await mangaKey(samples));
    } else if (record.format === "pdf" || (record.format === undefined && record.pdfBytes)) {
      if (record.pdfBytes) next.set(record.id, await pdfKey(record.pdfBytes));
    } else {
      next.set(record.id, await epubKey(record.chapters, record.resources ?? []));
    }
  }
  return next;
}
