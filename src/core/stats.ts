// Reading statistics domain — pure functions, no browser/DB dependencies
// (unit-tested in Node, see tests/stats-unit.ts).
//
// Raw data lives in IndexedDB as one record per LOCAL day (see storage.ts).
// Two volume units coexist: countable characters (EPUB) and pages (PDF) —
// they are never mixed into one number; the shared axis is active time.

export interface DailyStats {
  /** Local day, YYYY-MM-DD. */
  date: string;
  /** Countable EPUB characters read this day. */
  chars: number;
  /** PDF pages read this day. */
  pages: number;
  /** Active reading time, ms. */
  timeMs: number;
  /** Per-book slices of this day (only books that contributed something). */
  perBook?: Record<string, BookAmount>;
}

/** One book's slice of reading volume — same units as a day. */
export interface BookAmount {
  chars: number;
  pages: number;
  timeMs: number;
}

export interface StatsDelta {
  chars?: number;
  pages?: number;
  timeMs?: number;
}

/** Local day key — the reader's day, not UTC. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Shift a local day key by `offset` days (negative = back). */
export function shiftDay(key: string, offset: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y!, m! - 1, d! + offset).getTime());
}

export function applyDelta(day: DailyStats, delta: StatsDelta): DailyStats {
  return {
    ...day,
    chars: day.chars + (delta.chars ?? 0),
    pages: day.pages + (delta.pages ?? 0),
    timeMs: day.timeMs + (delta.timeMs ?? 0),
  };
}

/** The same delta attributed to one book's slice of the day. */
export function applyBookDelta(
  day: DailyStats,
  bookId: string,
  delta: StatsDelta,
): DailyStats {
  const perBook = { ...day.perBook };
  const current = perBook[bookId] ?? { chars: 0, pages: 0, timeMs: 0 };
  const next: BookAmount = {
    chars: current.chars + (delta.chars ?? 0),
    pages: current.pages + (delta.pages ?? 0),
    timeMs: current.timeMs + (delta.timeMs ?? 0),
  };
  if (next.chars + next.pages + next.timeMs > 0) perBook[bookId] = next;
  return { ...day, perBook };
}

/**
 * Reading speed: chars/hour for text volume, pages/hour when only pages
 * moved. Null under a minute of active time — the number means nothing on a
 * shorter sample. This is the decision; the label is presentation and lives
 * in lib/format.ts (speedLabel).
 */
export function speedOf(
  amount: BookAmount,
): { kind: "chars" | "pages"; perHour: number } | null {
  if (amount.timeMs < 60_000) return null;
  const hours = amount.timeMs / 3_600_000;
  if (amount.chars > 0)
    return { kind: "chars", perHour: Math.round(amount.chars / hours) };
  if (amount.pages > 0)
    return { kind: "pages", perHour: Math.round(amount.pages / hours) };
  return null;
}

/** A day counts toward a streak only when something was actually read. */
export function isActiveDay(day: DailyStats): boolean {
  return day.chars + day.pages > 0;
}

export interface Streaks {
  /** Days in a row ending today (today without reading doesn't break it). */
  current: number;
  best: number;
}

export function streaks(days: DailyStats[], todayKey: string): Streaks {
  const active = new Set(days.filter(isActiveDay).map((d) => d.date));
  // The current streak is anchored at today; if today has no reading yet,
  // anchor at yesterday — the streak is still alive until the day ends.
  const anchor = active.has(todayKey) ? todayKey : shiftDay(todayKey, -1);
  let current = 0;
  for (let key = anchor; active.has(key); key = shiftDay(key, -1)) {
    current += 1;
  }
  let best = 0;
  let run = 0;
  // Walk the sorted active days; a run continues while days are adjacent.
  const sorted = [...active].sort();
  let prev: string | null = null;
  for (const key of sorted) {
    run = prev !== null && shiftDay(prev, 1) === key ? run + 1 : 1;
    prev = key;
    if (run > best) best = run;
  }
  return { current, best };
}

export function totals(days: DailyStats[]): DailyStats {
  return days.reduce(
    (acc, d) => ({
      date: "",
      chars: acc.chars + d.chars,
      pages: acc.pages + d.pages,
      timeMs: acc.timeMs + d.timeMs,
    }),
    { date: "", chars: 0, pages: 0, timeMs: 0 },
  );
}

/**
 * Heatmap intensity 0..4 from the day's ACTIVE MINUTES — the one unit that
 * means the same for EPUB and PDF. Fixed thresholds, no quantiles, so a
 * cell's color is predictable.
 */
export function heatLevel(timeMs: number): number {
  const minutes = timeMs / 60_000;
  if (minutes <= 0) return 0;
  if (minutes <= 20) return 1;
  if (minutes <= 45) return 2;
  if (minutes <= 90) return 3;
  return 4;
}

/** One heatmap cell: its day key; future days (past today) render blank. */
interface HeatCell {
  key: string;
  future: boolean;
}

// Heatmap grid: `weeks` columns (oldest → current), 7 rows (Mon → Sun). The
// first column starts on the Monday `weeks` weeks back; days past today in
// the current week are flagged future so the view leaves them blank.
export function heatmapWeeks(todayKey: string, weeks: number): HeatCell[][] {
  const todayWeekday = (new Date().getDay() + 6) % 7;
  const startKey = shiftDay(todayKey, -((weeks - 1) * 7 + todayWeekday));
  const grid: HeatCell[][] = [];
  for (let w = 0; w < weeks; w += 1) {
    const week: HeatCell[] = [];
    for (let row = 0; row < 7; row += 1) {
      const key = shiftDay(startKey, w * 7 + row);
      week.push({ key, future: key > todayKey });
    }
    grid.push(week);
  }
  return grid;
}

// --- Chart series (the /stats charts section) ------------------------------
// Every series spans `n` calendar days ENDING at `todayKey` (inclusive);
// days without a record count as zero / skip. The anchor defaults to the
// real today — tests pass an explicit key.

/** Active minutes per day; missing days are 0. */
export function dailyMinutesSeries(
  days: DailyStats[],
  n: number,
  todayKey = dayKey(Date.now()),
): { key: string; minutes: number }[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const series: { key: string; minutes: number }[] = [];
  for (let back = n - 1; back >= 0; back -= 1) {
    const key = shiftDay(todayKey, -back);
    series.push({ key, minutes: (byDate.get(key)?.timeMs ?? 0) / 60_000 });
  }
  return series;
}

/** Trailing moving average; leading points average a partial window. */
export function movingAverage(values: number[], window: number): number[] {
  const w = Math.max(1, Math.floor(window));
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= w) sum -= values[i - w]!;
    out.push(sum / Math.min(i + 1, w));
  }
  return out;
}

/**
 * Reading speed per qualifying day (a minute of active time and up, same
 * rule as speedOf). `kind` follows the latest point — chars/h for text
 * reading, pages/h when only pages moved. Null when no day qualifies.
 */
export function speedSeries(
  days: DailyStats[],
  n: number,
  todayKey = dayKey(Date.now()),
): { kind: "chars" | "pages"; points: { key: string; perHour: number }[] } | null {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const points: { key: string; perHour: number }[] = [];
  let kind: "chars" | "pages" = "chars";
  for (let back = n - 1; back >= 0; back -= 1) {
    const key = shiftDay(todayKey, -back);
    const day = byDate.get(key);
    if (!day) continue;
    const speed = speedOf(day);
    if (!speed) continue;
    points.push({ key, perHour: speed.perHour });
    kind = speed.kind;
  }
  if (points.length === 0) return null;
  return { kind, points };
}

/** The book with the most read volume in the window; null when none. */
export function topBookInWindow(
  days: DailyStats[],
  n: number,
  todayKey = dayKey(Date.now()),
): string | null {
  const start = shiftDay(todayKey, -(n - 1));
  const sums = new Map<string, { chars: number; pages: number }>();
  for (const day of days) {
    if (day.date < start || day.date > todayKey || !day.perBook) continue;
    for (const [id, amount] of Object.entries(day.perBook)) {
      const sum = sums.get(id) ?? { chars: 0, pages: 0 };
      sum.chars += amount.chars;
      sum.pages += amount.pages;
      sums.set(id, sum);
    }
  }
  let top: string | null = null;
  let topChars = 0;
  let topPages = 0;
  for (const [id, sum] of sums) {
    if (sum.chars > topChars || (sum.chars === topChars && sum.pages > topPages)) {
      top = id;
      topChars = sum.chars;
      topPages = sum.pages;
    }
  }
  return top;
}

export interface BookPace {
  chars: number;
  pages: number;
  timeMs: number;
  /** Window days when the book contributed readable volume. */
  activeDays: number;
  /** Average speed over the window totals; null under a minute. */
  speed: { kind: "chars" | "pages"; perHour: number } | null;
}

/** One book's totals over the window; null when it has no slices there. */
export function bookPace(
  days: DailyStats[],
  bookId: string,
  n: number,
  todayKey = dayKey(Date.now()),
): BookPace | null {
  const start = shiftDay(todayKey, -(n - 1));
  const total: BookAmount = { chars: 0, pages: 0, timeMs: 0 };
  let activeDays = 0;
  let seen = false;
  for (const day of days) {
    if (day.date < start || day.date > todayKey) continue;
    const slice = day.perBook?.[bookId];
    if (!slice) continue;
    seen = true;
    total.chars += slice.chars;
    total.pages += slice.pages;
    total.timeMs += slice.timeMs;
    if (slice.chars + slice.pages > 0) activeDays += 1;
  }
  if (!seen) return null;
  return { ...total, activeDays, speed: speedOf(total) };
}

/**
 * Days left at the current pace: the remaining volume extrapolated from
 * progress, divided by the per-active-day amount. Null when the estimate
 * means nothing (nothing read, progress unset, effectively finished, or a
 * dead pace). Always at least one day when there is anything left.
 */
export function estimateDaysLeft(
  readAmount: number,
  progress: number,
  amountPerActiveDay: number,
): number | null {
  if (readAmount <= 0 || amountPerActiveDay <= 0) return null;
  if (progress <= 0 || progress >= 0.995) return null;
  const remaining = (readAmount * (1 - progress)) / progress;
  return Math.max(1, Math.ceil(remaining / amountPerActiveDay));
}

// --- Daily goal (localStorage, same pattern as reading-settings.ts) -------
//
// Two modes: a flat character count ("3 000 знаков в день") or a percent of
// the CURRENT book ("8% в день" — the target scales with the book's length;
// for a PDF the percent applies to its pages). Both values are persisted, so
// switching modes never loses the other setting.

export type GoalMode = "chars" | "percent";

interface DailyGoal {
  mode: GoalMode;
  chars: number;
  percent: number;
  /** Book the percent mode scales from; unset = the current read. */
  bookId?: string;
}

const GOAL_KEY = "yuki:stats-goal";
export const GOAL_CHARS_MIN = 1000;
export const GOAL_CHARS_MAX = 50000;
export const GOAL_CHARS_STEP = 500;
const GOAL_CHARS_DEFAULT = 3000;
export const GOAL_PERCENT_MIN = 1;
export const GOAL_PERCENT_MAX = 50;
export const GOAL_PERCENT_STEP = 1;
const GOAL_PERCENT_DEFAULT = 8;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function loadDailyGoal(): DailyGoal {
  try {
    const raw = localStorage.getItem(GOAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      // Back-compat: the first version stored a bare number (chars mode).
      if (typeof parsed === "number" && Number.isFinite(parsed)) {
        return {
          mode: "chars",
          chars: clamp(parsed, GOAL_CHARS_MIN, GOAL_CHARS_MAX),
          percent: GOAL_PERCENT_DEFAULT,
        };
      }
      if (parsed && typeof parsed === "object") {
        const p = parsed as {
          mode?: unknown;
          chars?: unknown;
          percent?: unknown;
          bookId?: unknown;
        };
        return {
          mode: p.mode === "percent" ? "percent" : "chars",
          chars:
            typeof p.chars === "number"
              ? clamp(p.chars, GOAL_CHARS_MIN, GOAL_CHARS_MAX)
              : GOAL_CHARS_DEFAULT,
          percent:
            typeof p.percent === "number"
              ? clamp(p.percent, GOAL_PERCENT_MIN, GOAL_PERCENT_MAX)
              : GOAL_PERCENT_DEFAULT,
          ...(typeof p.bookId === "string" ? { bookId: p.bookId } : {}),
        };
      }
    }
  } catch {
    // ignore malformed storage
  }
  return { mode: "chars", chars: GOAL_CHARS_DEFAULT, percent: GOAL_PERCENT_DEFAULT };
}

export function saveDailyGoal(goal: DailyGoal): void {
  try {
    localStorage.setItem(GOAL_KEY, JSON.stringify(goal));
  } catch {
    // storage may be unavailable
  }
}

/**
 * Today's target amount: the flat count in chars mode, or percent% of the
 * book's volume (chars for EPUB, pages for PDF). Null = percent mode without
 * a current book. The `done` amount uses the same unit as the target.
 */
export function goalTarget(
  goal: DailyGoal,
  bookVolume: number | null,
): number | null {
  if (goal.mode === "chars") return goal.chars;
  if (bookVolume === null || bookVolume <= 0) return null;
  return Math.max(1, Math.round((bookVolume * goal.percent) / 100));
}
