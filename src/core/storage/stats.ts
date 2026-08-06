import {
  applyBookDelta,
  applyDelta,
  dayKey,
  type BookAmount,
  type DailyStats,
  type StatsDelta,
} from "../stats";
import { STATS, open } from "./db";

// --- Reading statistics ----------------------------------------------------

/**
 * Merge a reading-session delta into today's record (read-modify-write).
 * The day is stamped at write time — no midnight splitting. With `bookId`
 * the same delta is also attributed to that book's slice of the day.
 */
export async function addStatsDelta(
  delta: StatsDelta,
  bookId?: string,
): Promise<void> {
  const db = await open();
  const key = dayKey(Date.now());
  const current = (await db.get(STATS, key)) ?? {
    date: key,
    chars: 0,
    pages: 0,
    timeMs: 0,
  };
  let next = applyDelta(current, delta);
  if (bookId) next = applyBookDelta(next, bookId, delta);
  await db.put(STATS, next);
}

/** All-time volume of one book: its per-day slices summed. */
export async function loadBookStats(bookId: string): Promise<BookAmount> {
  const db = await open();
  const days = await db.getAll(STATS);
  const total: BookAmount = { chars: 0, pages: 0, timeMs: 0 };
  for (const day of days) {
    const slice = day.perBook?.[bookId];
    if (!slice) continue;
    total.chars += slice.chars;
    total.pages += slice.pages;
    total.timeMs += slice.timeMs;
  }
  return total;
}

export async function loadStats(): Promise<DailyStats[]> {
  const db = await open();
  const days = await db.getAll(STATS);
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putStatsDay(day: DailyStats): Promise<void> {
  const db = await open();
  await db.put(STATS, day);
}
