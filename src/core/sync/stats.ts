import { dayKey, type BookAmount, type DailyStats } from "../stats";
import { loadStats } from "../storage";
import type { BookKey, MonthStats } from "./model";
import { syncStore } from "./store";

// Statistics across devices: every device publishes ONLY its own counters
// (devices/<id>/stats/<month>), so the total is a plain sum — nothing is
// ever counted twice, and re-downloading a month changes nothing ("totals
// never recount", mokuro's event-log lesson; ttu/Yatsu's "newest day wins"
// lost the second device's reading). This device's own days stay in the
// library's stats store; other devices' months live in the sync database.

/** One other device's month as cached by the engine. */
export interface RemoteMonth {
  device: string;
  days: MonthStats;
}

const sameCounts = (a: BookAmount, b: BookAmount): boolean =>
  a.chars === b.chars && a.pages === b.pages && a.timeMs === b.timeMs;

/** Local days + every other device's days. Per-book slices come back under
    LOCAL ids where the book exists here (others keep their content key — the
    day totals count them, per-book views just don't find them).
    A remote day identical to the local one is counted once ONLY when it lies
    before `copiesBefore` (the day this device joined sync): such a day is a
    copy restored from a backup made on the other device. After joining, two
    devices reading exactly the same amount is real reading and adds up. */
export function mergeStatsDays(
  local: readonly DailyStats[],
  remote: Iterable<RemoteMonth>,
  localIdOf: (key: BookKey) => string | undefined,
  copiesBefore = "",
): DailyStats[] {
  const days = new Map<string, DailyStats>();
  for (const day of local) {
    days.set(day.date, { ...day, perBook: { ...day.perBook } });
  }
  for (const month of remote) {
    for (const [date, count] of Object.entries(month.days)) {
      const mine = local.find((day) => day.date === date);
      const copy = date < copiesBefore && count.chars + count.pages + count.timeMs > 0;
      if (mine && copy && sameCounts(mine, count)) continue;
      const day = days.get(date) ?? { date, chars: 0, pages: 0, timeMs: 0, perBook: {} };
      day.chars += count.chars;
      day.pages += count.pages;
      day.timeMs += count.timeMs;
      const perBook = { ...day.perBook };
      for (const [key, slice] of Object.entries(count.perBook ?? {})) {
        const id = localIdOf(key) ?? key;
        const current = perBook[id] ?? { chars: 0, pages: 0, timeMs: 0 };
        perBook[id] = {
          chars: current.chars + slice.chars,
          pages: current.pages + slice.pages,
          timeMs: current.timeMs + slice.timeMs,
        };
      }
      day.perBook = perBook;
      days.set(date, day);
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** What the statistics screens show: this device plus every synced one. */
export async function loadMergedStats(): Promise<DailyStats[]> {
  const local = await loadStats();
  const cached = await syncStore.remoteStats();
  if (cached.size === 0) return local;
  const keys = await syncStore.bookKeys();
  const idOf = new Map<BookKey, string>();
  for (const [id, key] of keys) idOf.set(key, id);
  const remote: RemoteMonth[] = [];
  for (const [slot, month] of cached) remote.push({ device: slot.split("/")[0] ?? "", days: month.days });
  const joined = await syncStore.joinedAt();
  return mergeStatsDays(local, remote, (key) => idOf.get(key), joined ? dayKey(joined) : "");
}

/** One book's all-time volume across devices. */
export async function loadMergedBookStats(bookId: string): Promise<BookAmount> {
  const total: BookAmount = { chars: 0, pages: 0, timeMs: 0 };
  for (const day of await loadMergedStats()) {
    const slice = day.perBook?.[bookId];
    if (!slice) continue;
    total.chars += slice.chars;
    total.pages += slice.pages;
    total.timeMs += slice.timeMs;
  }
  return total;
}
