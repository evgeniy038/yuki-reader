// Node unit test for the reading-statistics domain (src/core/stats.ts):
// day keys, streaks, totals, heat levels, goal math. Pure functions — no
// browser needed. Run: pnpm tsx tests/stats-unit.ts

import { strict as assert } from "node:assert";
import {
  applyBookDelta,
  applyDelta,
  bookPace,
  dailyMinutesSeries,
  dayKey,
  estimateDaysLeft,
  goalTarget,
  heatLevel,
  isActiveDay,
  movingAverage,
  shiftDay,
  speedOf,
  speedSeries,
  streaks,
  topBookInWindow,
  totals,
  type DailyStats,
} from "../src/core/stats.ts";

function day(date: string, patch: Partial<DailyStats> = {}): DailyStats {
  return { date, chars: 100, pages: 0, timeMs: 60_000, ...patch };
}

// --- dayKey / shiftDay round-trip ------------------------------------------
{
  const key = dayKey(new Date(2026, 6, 28, 23, 59).getTime());
  assert.equal(key, "2026-07-28");
  assert.equal(shiftDay(key, -1), "2026-07-27");
  assert.equal(shiftDay(key, 1), "2026-07-29");
  // Month and year boundaries.
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDay(shiftDay(key, -30), 30), key);
  console.log("  ✓ dayKey/shiftDay round-trip and boundaries");
}

// --- applyDelta -------------------------------------------------------------
{
  const merged = applyDelta(day("2026-07-28"), { chars: 50, timeMs: 5000 });
  assert.deepEqual(merged, {
    date: "2026-07-28",
    chars: 150,
    pages: 0,
    timeMs: 65_000,
  });
  // A per-book slice survives a day-level merge.
  const withBook = applyDelta(
    day("2026-07-28", {
      perBook: { b1: { chars: 10, pages: 0, timeMs: 1000 } },
    }),
    { chars: 5 },
  );
  assert.deepEqual(withBook.perBook, { b1: { chars: 10, pages: 0, timeMs: 1000 } });
  console.log("  ✓ applyDelta merges partial deltas, keeps per-book slices");
}

// --- applyBookDelta: the same delta under a book's slice --------------------
{
  // First contribution creates the slice.
  {
    const d = applyBookDelta(day("2026-07-28"), "b1", { chars: 40, timeMs: 2000 });
    assert.deepEqual(d.perBook, { b1: { chars: 40, pages: 0, timeMs: 2000 } });
    // Day-level numbers are untouched — attribution, not double counting.
    assert.equal(d.chars, 100);
  }
  // Contributions accumulate; books don't see each other.
  {
    let d = day("2026-07-28");
    d = applyBookDelta(d, "b1", { chars: 40, timeMs: 2000 });
    d = applyBookDelta(d, "b2", { pages: 3, timeMs: 5000 });
    d = applyBookDelta(d, "b1", { chars: 10, timeMs: 1000 });
    assert.deepEqual(d.perBook, {
      b1: { chars: 50, pages: 0, timeMs: 3000 },
      b2: { chars: 0, pages: 3, timeMs: 5000 },
    });
  }
  // An empty delta leaves no trace.
  {
    const d = applyBookDelta(day("2026-07-28"), "b1", {});
    assert.deepEqual(d.perBook, {});
  }
  console.log("  ✓ applyBookDelta attributes per book, skips empty traces");
}

// --- speedOf: chars/h vs pages/h, guarded below a minute --------------------
{
  assert.deepEqual(speedOf({ chars: 6000, pages: 0, timeMs: 3_600_000 }), {
    kind: "chars",
    perHour: 6000,
  });
  assert.deepEqual(speedOf({ chars: 0, pages: 30, timeMs: 3_600_000 }), {
    kind: "pages",
    perHour: 30,
  });
  assert.deepEqual(speedOf({ chars: 900, pages: 0, timeMs: 1_800_000 }), {
    kind: "chars",
    perHour: 1800,
  });
  // Chars win when both moved (a mixed day is text-dominated).
  assert.deepEqual(speedOf({ chars: 100, pages: 5, timeMs: 3_600_000 }), {
    kind: "chars",
    perHour: 100,
  });
  // Under a minute of active time the number means nothing.
  assert.equal(speedOf({ chars: 500, pages: 0, timeMs: 59_000 }), null);
  assert.equal(speedOf({ chars: 0, pages: 0, timeMs: 3_600_000 }), null);
  console.log("  ✓ speedOf: chars/h and pages/h, null under a minute");
}

// --- isActiveDay: volume only, time alone doesn't count ---------------------
{
  assert.equal(isActiveDay(day("2026-07-28")), true);
  assert.equal(isActiveDay(day("2026-07-28", { chars: 0, pages: 3 })), true);
  assert.equal(isActiveDay(day("2026-07-28", { chars: 0, timeMs: 9e6 })), false);
  console.log("  ✓ isActiveDay needs chars or pages, not time alone");
}

// --- streaks ----------------------------------------------------------------
{
  const today = "2026-07-28";
  // Today read, plus two days back → current 3.
  {
    const { current, best } = streaks(
      [day("2026-07-26"), day("2026-07-27"), day("2026-07-28")],
      today,
    );
    assert.equal(current, 3);
    assert.equal(best, 3);
  }
  // Today not yet read, yesterday was → streak still alive at 2.
  {
    const { current } = streaks(
      [day("2026-07-26"), day("2026-07-27")],
      today,
    );
    assert.equal(current, 2);
  }
  // Gap yesterday → streak dead even though older days exist.
  {
    const { current, best } = streaks(
      [day("2026-07-25"), day("2026-07-26")],
      today,
    );
    assert.equal(current, 0);
    assert.equal(best, 2);
  }
  // Best picks the longest historical run, not the latest.
  {
    const { best } = streaks(
      [
        day("2026-07-01"),
        day("2026-07-02"),
        day("2026-07-03"),
        day("2026-07-04"),
        day("2026-07-27"),
        day("2026-07-28"),
      ],
      today,
    );
    assert.equal(best, 4);
  }
  // Empty history → zeros.
  {
    assert.deepEqual(streaks([], today), { current: 0, best: 0 });
  }
  // Days out of order in the input don't matter.
  {
    const { current } = streaks(
      [day("2026-07-28"), day("2026-07-26"), day("2026-07-27")],
      today,
    );
    assert.equal(current, 3);
  }
  console.log("  ✓ streaks: today empty tolerated, gaps break, best is max run");
}

// --- totals -----------------------------------------------------------------
{
  const t = totals([
    day("2026-07-27", { chars: 10, pages: 2, timeMs: 1000 }),
    day("2026-07-28", { chars: 20, pages: 3, timeMs: 2000 }),
  ]);
  assert.equal(t.chars, 30);
  assert.equal(t.pages, 5);
  assert.equal(t.timeMs, 3000);
  console.log("  ✓ totals sums every unit");
}

// --- heatLevel: fixed minute thresholds -------------------------------------
{
  assert.equal(heatLevel(0), 0);
  assert.equal(heatLevel(20 * 60_000), 1);
  assert.equal(heatLevel(20 * 60_000 + 1), 2);
  assert.equal(heatLevel(45 * 60_000), 2);
  assert.equal(heatLevel(90 * 60_000), 3);
  assert.equal(heatLevel(90 * 60_000 + 1), 4);
  console.log("  ✓ heatLevel thresholds 0/20/45/90");
}

// --- goalTarget: flat count vs percent of the book --------------------------
{
  const chars = { mode: "chars" as const, chars: 3000, percent: 8 };
  const percent = { mode: "percent" as const, chars: 3000, percent: 8 };
  assert.equal(goalTarget(chars, null), 3000);
  assert.equal(goalTarget(chars, 76_000), 3000); // volume ignored
  assert.equal(goalTarget(percent, 76_000), 6080); // 8% of the book
  assert.equal(goalTarget(percent, null), null); // no current book
  assert.equal(goalTarget(percent, 0), null);
  assert.equal(goalTarget({ ...percent, percent: 1 }, 50), 1); // floors at 1
  console.log("  ✓ goalTarget: chars flat, percent of volume, null without book");
}

// --- dailyMinutesSeries: window anchored at today, missing days are zero ---
{
  const today = "2026-07-28";
  assert.deepEqual(
    dailyMinutesSeries(
      [
        day("2026-07-27", { timeMs: 30 * 60_000 }),
        day("2026-07-28", { timeMs: 90 * 60_000 }),
      ],
      3,
      today,
    ),
    [
      { key: "2026-07-26", minutes: 0 },
      { key: "2026-07-27", minutes: 30 },
      { key: "2026-07-28", minutes: 90 },
    ],
  );
  // Empty input → flat zeros, still one point per day.
  assert.deepEqual(dailyMinutesSeries([], 2, today), [
    { key: "2026-07-27", minutes: 0 },
    { key: "2026-07-28", minutes: 0 },
  ]);
  // Days outside the window are ignored.
  assert.ok(
    dailyMinutesSeries([day("2026-07-01", { timeMs: 60_000 })], 3, today).every(
      (p) => p.minutes === 0,
    ),
  );
  console.log("  ✓ dailyMinutesSeries: window, missing days zero, old days ignored");
}

// --- movingAverage: trailing window, partial heads, zero guards -------------
{
  assert.deepEqual(movingAverage([], 7), []);
  assert.deepEqual(movingAverage([10, 20, 30], 2), [10, 15, 25]);
  // Window longer than the series: partial averages, no division blowups.
  assert.deepEqual(movingAverage([4, 8], 5), [4, 6]);
  assert.deepEqual(movingAverage([0, 0, 0], 2), [0, 0, 0]);
  // A sub-1 window degrades to the identity, not a crash.
  assert.deepEqual(movingAverage([3, 5], 0), [3, 5]);
  console.log("  ✓ movingAverage: partial heads, long window, zeros");
}

// --- speedSeries: speedOf rules per day, gaps skip, pages fallback ----------
{
  const today = "2026-07-28";
  assert.deepEqual(
    speedSeries(
      [
        day("2026-07-27", { chars: 6000, timeMs: 3_600_000 }),
        day("2026-07-28", { chars: 500, timeMs: 30_000 }), // <1 min — skipped
      ],
      2,
      today,
    ),
    { kind: "chars", points: [{ key: "2026-07-27", perHour: 6000 }] },
  );
  // Page-only days report pages/h.
  assert.deepEqual(
    speedSeries(
      [day("2026-07-28", { chars: 0, pages: 30, timeMs: 3_600_000 })],
      1,
      today,
    ),
    { kind: "pages", points: [{ key: "2026-07-28", perHour: 30 }] },
  );
  // No qualifying day → null (empty input, or only sub-minute samples).
  assert.equal(speedSeries([], 14, today), null);
  assert.equal(
    speedSeries([day("2026-07-28", { chars: 100, timeMs: 10_000 })], 1, today),
    null,
  );
  console.log("  ✓ speedSeries: chars/h, pages/h fallback, null without a minute");
}

// --- topBookInWindow: most volume wins, pages break char-less ties ----------
{
  const today = "2026-07-28";
  const days = [
    day("2026-07-27", {
      perBook: {
        b1: { chars: 100, pages: 0, timeMs: 1000 },
        b2: { chars: 300, pages: 0, timeMs: 1000 },
      },
    }),
    day("2026-07-28", { perBook: { b1: { chars: 250, pages: 0, timeMs: 1000 } } }),
  ];
  assert.equal(topBookInWindow(days, 2, today), "b1"); // 350 vs 300
  // A char-less (PDF) library falls back to pages.
  assert.equal(
    topBookInWindow(
      [day("2026-07-28", { chars: 0, perBook: { p1: { chars: 0, pages: 4, timeMs: 1000 } } })],
      1,
      today,
    ),
    "p1",
  );
  // Slices outside the window don't count.
  assert.equal(
    topBookInWindow([day("2026-07-01", { perBook: { b9: { chars: 999, pages: 0, timeMs: 1000 } } })], 2, today),
    null,
  );
  assert.equal(topBookInWindow([], 14, today), null);
  console.log("  ✓ topBookInWindow: max volume, pages fallback, window bounds");
}

// --- bookPace: window totals + average speed for one book -------------------
{
  const today = "2026-07-28";
  const days = [
    day("2026-07-27", { perBook: { b1: { chars: 6000, pages: 0, timeMs: 3_600_000 } } }),
    day("2026-07-28", { perBook: { b1: { chars: 3000, pages: 0, timeMs: 1_800_000 } } }),
    // Outside the 2-day window — must not leak into the totals.
    day("2026-07-20", { perBook: { b1: { chars: 99_999, pages: 0, timeMs: 3_600_000 } } }),
  ];
  assert.deepEqual(bookPace(days, "b1", 2, today), {
    chars: 9000,
    pages: 0,
    timeMs: 5_400_000,
    activeDays: 2,
    speed: { kind: "chars", perHour: 6000 }, // 9000 chars over 1.5 h
  });
  // A book with no slices in the window → null.
  assert.equal(bookPace(days, "missing", 2, today), null);
  assert.equal(bookPace([], "b1", 14, today), null);
  console.log("  ✓ bookPace: window totals, active days, null for unknown books");
}

// --- estimateDaysLeft: extrapolation with hard guards -----------------------
{
  // 9000 read at 40% → 13 500 left, at 4 500 a day → 3 days.
  assert.equal(estimateDaysLeft(9000, 0.4, 4500), 3);
  // Rounds UP to full days: 1000 left at 600 a day → 2.
  assert.equal(estimateDaysLeft(1000, 0.5, 600), 2);
  // Nothing left to speak of still floors at one day.
  assert.equal(estimateDaysLeft(1000, 0.99, 5000), 1);
  // Guards: nothing read, unset progress, effectively finished, dead pace.
  assert.equal(estimateDaysLeft(0, 0.4, 4500), null);
  assert.equal(estimateDaysLeft(9000, 0, 4500), null);
  assert.equal(estimateDaysLeft(9000, -1, 4500), null);
  assert.equal(estimateDaysLeft(9000, 0.995, 4500), null);
  assert.equal(estimateDaysLeft(9000, 1, 4500), null);
  assert.equal(estimateDaysLeft(9000, 0.4, 0), null);
  console.log("  ✓ estimateDaysLeft: extrapolation, ceil, zero-division guards");
}

console.log("stats-unit: all checks passed");
