type FontFamilyId = "noto-serif-jp" | "sans" | "serif" | "gothic";
type ReadingThemeId = "light" | "sepia" | "dark";

export interface ReadingSettings {
  fontFamily: FontFamilyId;
  fontSize: number;
  fontWeight: number;
  /** Unitless line-height; unset-ish default keeps the CSS fallbacks close. */
  lineHeight: number;
  /** Show ruby annotations (furigana) in the reader. */
  furigana: boolean;
  /** Page margins, px: head/foot inset + cross-axis padding of the page box. */
  pageMargin: number;
  /** Reading surface theme (EPUB page + PDF page alike), NOT the app theme. */
  theme: ReadingThemeId;
  /** Treat the first manga page as a cover (single page, not a spread). */
  mangaFirstPageAsCover: boolean;
}

// Reading surface themes: page background + text color for the text reader,
// a canvas filter for the PDF reader (its pages are rasters of print — the
// dark/sepia "paper" is a recolor, like Zathura's recolor mode). The app UI
// itself stays untouched.
const READING_THEMES: {
  id: ReadingThemeId;
  /** Page background + text/muted colors for the EPUB reader. */
  bg: string;
  text: string;
  muted: string;
  /** CSS filter over the PDF page canvas ("none" = print as authored). */
  pdfFilter: string;
}[] = [
  {
    id: "light",
    bg: "oklch(96.25% 0.0022 67.8)",
    text: "#1d1d1f",
    muted: "#86868b",
    pdfFilter: "none",
  },
  {
    id: "sepia",
    bg: "#f5eeda",
    text: "#4a4234",
    muted: "#a2957d",
    pdfFilter: "sepia(0.42) brightness(0.96)",
  },
  {
    id: "dark",
    bg: "#1b1b1d",
    text: "#d4d4d6",
    muted: "#8e8e93",
    pdfFilter: "invert(0.94) hue-rotate(180deg)",
  },
];

export function readingTheme(id: ReadingThemeId) {
  return READING_THEMES.find((t) => t.id === id) ?? READING_THEMES[0]!;
}

export const FONT_SIZE_MIN = 14;
export const FONT_FAMILY_DEFAULT: FontFamilyId = "noto-serif-jp";
// No upper cap: EPUB font size is unbounded above. Kept as an export so the
// stepper's canIncrement (`fontSize < FONT_SIZE_MAX`) never disables "+".
export const FONT_SIZE_MAX = Infinity;
export const FONT_SIZE_STEP = 2;
export const FONT_SIZE_DEFAULT = 18;
export const FONT_WEIGHT_MIN = 200;
export const FONT_WEIGHT_MAX = 900;
export const FONT_WEIGHT_STEP = 100;
export const FONT_WEIGHT_DEFAULT = 400;

export const LINE_HEIGHT_MIN = 1.4;
export const LINE_HEIGHT_MAX = 2.2;
export const LINE_HEIGHT_STEP = 0.1;
export const LINE_HEIGHT_DEFAULT = 1.9;

export const PAGE_MARGIN_MIN = 16;
export const PAGE_MARGIN_MAX = 80;
export const PAGE_MARGIN_STEP = 4;
export const PAGE_MARGIN_DEFAULT = 40;

const FONT_FAMILIES: { id: FontFamilyId; label: string; stack: string }[] = [
  {
    id: "noto-serif-jp",
    label: "Noto Serif JP",
    stack: '"Noto Serif JP Variable", "Noto Serif JP", serif',
  },
  {
    id: "sans",
    label: "Sans",
    stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  },
  {
    id: "serif",
    label: "Mincho",
    stack: '"Hiragino Mincho ProN", "Yu Mincho", ui-serif, Georgia, serif',
  },
  {
    id: "gothic",
    label: "Gothic",
    stack: '"Hiragino Kaku Gothic ProN", "Yu Gothic", ui-sans-serif, system-ui, sans-serif',
  },
];

const STORAGE_KEY = "yuki:reading";

export function fontFamilyStack(id: FontFamilyId): string {
  return FONT_FAMILIES.find((f) => f.id === id)?.stack ?? FONT_FAMILIES[0]!.stack;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Only a lower bound: finite sizes pass through uncapped; non-finite
// (NaN/±Infinity) falls back to the default.
export const clampFontSize = (size: number) =>
  Number.isFinite(size) ? Math.max(FONT_SIZE_MIN, size) : FONT_SIZE_DEFAULT;

export const clampFontWeight = (weight: number) =>
  Number.isFinite(weight)
    ? Math.min(
        FONT_WEIGHT_MAX,
        Math.max(
          FONT_WEIGHT_MIN,
          Math.round(weight / FONT_WEIGHT_STEP) * FONT_WEIGHT_STEP,
        ),
      )
    : FONT_WEIGHT_DEFAULT;

// Font options shared by Settings and the reader's quick popover (they must
// never drift).
// Theme labels come from the locales (settings.themeLight/Sepia/Dark);
// font names are proper names and stay as-is.
export const FONT_OPTIONS = FONT_FAMILIES.map((family) => ({
  value: family.id,
  label: family.label,
}));

export const THEME_SEGMENTS = READING_THEMES.map((theme) => ({
  value: theme.id,
}));

const numberOr = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" ? clamp(value, min, max) : fallback;

export function loadReadingSettings(): ReadingSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        fontFamily?: unknown;
        fontSize?: unknown;
        fontWeight?: unknown;
        lineHeight?: unknown;
        furigana?: unknown;
        pageMargin?: unknown;
        theme?: unknown;
        mangaFirstPageAsCover?: unknown;
      };
      const fontFamily: FontFamilyId =
        parsed.fontFamily === "noto-serif-jp" ||
        parsed.fontFamily === "serif" ||
        parsed.fontFamily === "gothic" ||
        parsed.fontFamily === "sans"
          ? parsed.fontFamily
          : FONT_FAMILY_DEFAULT;
      const theme: ReadingThemeId =
        parsed.theme === "sepia" || parsed.theme === "dark"
          ? parsed.theme
          : "light";
      return {
        fontFamily,
        fontSize:
          typeof parsed.fontSize === "number"
            ? clampFontSize(parsed.fontSize)
            : FONT_SIZE_DEFAULT,
        fontWeight:
          typeof parsed.fontWeight === "number"
            ? clampFontWeight(parsed.fontWeight)
            : FONT_WEIGHT_DEFAULT,
        lineHeight: numberOr(
          parsed.lineHeight,
          LINE_HEIGHT_MIN,
          LINE_HEIGHT_MAX,
          LINE_HEIGHT_DEFAULT,
        ),
        furigana:
          typeof parsed.furigana === "boolean" ? parsed.furigana : true,
        pageMargin: numberOr(
          parsed.pageMargin,
          PAGE_MARGIN_MIN,
          PAGE_MARGIN_MAX,
          PAGE_MARGIN_DEFAULT,
        ),
        theme,
        mangaFirstPageAsCover:
          typeof parsed.mangaFirstPageAsCover === "boolean"
            ? parsed.mangaFirstPageAsCover
            : true,
      };
    }
  } catch {
    // ignore malformed storage
  }
  return {
    fontFamily: FONT_FAMILY_DEFAULT,
    fontSize: FONT_SIZE_DEFAULT,
    fontWeight: FONT_WEIGHT_DEFAULT,
    lineHeight: LINE_HEIGHT_DEFAULT,
    furigana: true,
    pageMargin: PAGE_MARGIN_DEFAULT,
    theme: "light",
    mangaFirstPageAsCover: true,
  };
}

export function saveReadingSettings(settings: ReadingSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage may be unavailable
  }
}
