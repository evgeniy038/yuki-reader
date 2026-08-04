import { useCallback, useEffect, useRef, useState } from "react";
import type { BookFormat } from "@/core/library";
import { addStatsDelta } from "@/core/storage";
import { useLatest } from "@/lib/use-latest";

// The reading session: everything a single book-opening accumulates, and the
// rules for when any of it becomes permanent. Two clocks drive it:
//   Bookmark dwell (3s) — a page the reader LINGERS on becomes the restore
//     point; fast flipping (in either direction) never moves it, and a
//     pending dwell dies with the session instead of committing on exit.
//   Active-time heartbeat (5s) — time accrues only while the app is visible
//     and the last activity (turn, wheel, key, click, mouse move) is fresh.
//     A session under the 10s warmup is a peek visit: nothing it piled up
//     reaches the stats log. Volume counts per page: a dwelled page's
//     characters count once per session, so flipping back never subtracts
//     and re-reading within a session is free.

// A page becomes the bookmark only after 3s of dwelling on it.
const BOOKMARK_DWELL_MS = 3000;
// Peek visits under 10s of active time never reach the stats log.
const STATS_WARMUP_MS = 10_000;
const STATS_FLUSH_MS = 1500;
const HEARTBEAT_MS = 5000;
const ACTIVITY_IDLE_MS = 60_000;
// Pointer moves fire continuously while scanning with a hover dictionary —
// bump the activity stamp at most this often, not per event.
const ACTIVITY_POINTER_MS = 5000;
// A move of more than 5% of the book between consecutive position reports is
// a jump, not reading: the position before it becomes the return target.
const JUMP_DELTA = 0.05;

interface Session {
  activeMs: number;
  pendingChars: number;
  pendingPages: number;
  pendingTimeMs: number;
  /** Absolute positions already counted this session (never counted twice). */
  counted: Set<number>;
}

const freshSession = (): Session => ({
  activeMs: 0,
  pendingChars: 0,
  pendingPages: 0,
  pendingTimeMs: 0,
  counted: new Set(),
});

export function useReadingSession({
  bookId,
  format,
  onBookmark,
}: {
  /** The open book; null = no session (the heartbeat simply doesn't run). */
  bookId: string | null;
  format: BookFormat | undefined;
  /** Fired when the bookmark dwell commits: persist the restore point. */
  onBookmark: (bookId: string, progress: number) => void;
}) {
  const sessionRef = useRef<Session>(freshSession());
  const lastStatsFlushRef = useRef(0);
  const lastActivityRef = useRef(0);
  // The bookmark dwell timer: restarted on every page turn; when it runs
  // out, the page the reader is on becomes the restore point.
  const dwellRef = useRef(0);
  const onBookmarkRef = useLatest(onBookmark);
  const formatRef = useLatest(format);
  // The position before the last jump — offered as a return point until the
  // reader comes back, another jump supersedes it, or the session resets.
  const [jumpBack, setJumpBack] = useState<{ progress: number } | null>(null);
  // Last reported progress; null until the session's baseline report lands
  // (the first report after start/reset is a baseline, never a jump).
  const prevProgressRef = useRef<number | null>(null);

  // Warmup gate: a session starts counting only after 10s of active time —
  // shorter visits are peeks and nothing they piled up reaches the log.
  const flush = (id: string | null) => {
    const s = sessionRef.current;
    if (s.activeMs >= STATS_WARMUP_MS) {
      if (s.pendingChars > 0 || s.pendingPages > 0 || s.pendingTimeMs > 0) {
        void addStatsDelta(
          { chars: s.pendingChars, pages: s.pendingPages, timeMs: s.pendingTimeMs },
          id ?? undefined,
        );
        s.pendingChars = 0;
        s.pendingPages = 0;
        s.pendingTimeMs = 0;
      }
    }
    lastStatsFlushRef.current = Date.now();
  };

  // Position and stats, both dwell-driven: every page turn (or relayout)
  // restarts the 3s timer; when it runs out, the page the reader is on
  // becomes the bookmark and its characters count once per session.
  const updateProgress = (progress: number, absolute: number, pageChars: number) => {
    lastActivityRef.current = Date.now();
    if (!bookId) return;
    const prevProgress = prevProgressRef.current;
    prevProgressRef.current = progress;
    if (prevProgress !== null && Math.abs(progress - prevProgress) > JUMP_DELTA)
      setJumpBack({ progress: prevProgress });
    const id = bookId;
    window.clearTimeout(dwellRef.current);
    dwellRef.current = window.setTimeout(() => {
      onBookmarkRef.current?.(id, progress);
      const s = sessionRef.current;
      if (!s.counted.has(absolute)) {
        s.counted.add(absolute);
        if (formatRef.current === "pdf" || formatRef.current === "manga")
          s.pendingPages += pageChars;
        else s.pendingChars += pageChars;
      }
      const now = Date.now();
      if (now - lastStatsFlushRef.current >= STATS_FLUSH_MS) flush(id);
    }, BOOKMARK_DWELL_MS);
  };

  // A fresh session: the counted-page set and the warmup clock reset, so a
  // reopen never inherits the previous visit's accumulation.
  const resetSession = () => {
    window.clearTimeout(dwellRef.current);
    sessionRef.current = freshSession();
    const now = Date.now();
    lastActivityRef.current = now;
    lastStatsFlushRef.current = now;
    prevProgressRef.current = null;
    setJumpBack(null);
  };

  const clearJumpBack = useCallback(() => setJumpBack(null), []);

  useEffect(() => {
    if (!bookId) return;
    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };
    // Hover-dictionary readers scan with the mouse alone — no wheel, keys or
    // clicks — so movement counts too, throttled to one stamp per 5s.
    const markPointerActivity = () => {
      if (Date.now() - lastActivityRef.current < ACTIVITY_POINTER_MS) return;
      lastActivityRef.current = Date.now();
    };
    window.addEventListener("wheel", markActivity, { passive: true });
    window.addEventListener("keydown", markActivity);
    window.addEventListener("pointerdown", markActivity, { passive: true });
    window.addEventListener("pointermove", markPointerActivity, { passive: true });
    const heartbeat = window.setInterval(() => {
      const now = Date.now();
      if (document.visibilityState !== "visible") return;
      if (now - lastActivityRef.current >= ACTIVITY_IDLE_MS) return;
      sessionRef.current.pendingTimeMs += HEARTBEAT_MS;
      sessionRef.current.activeMs += HEARTBEAT_MS;
      if (now - lastStatsFlushRef.current >= STATS_FLUSH_MS) flush(bookId);
    }, HEARTBEAT_MS);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("wheel", markActivity);
      window.removeEventListener("keydown", markActivity);
      window.removeEventListener("pointerdown", markActivity);
      window.removeEventListener("pointermove", markPointerActivity);
      // A pending dwell dies with the session: the bookmark stays where the
      // reader actually lingered, not where they flipped through last. The
      // cleanup flush covers every reader exit, so no pending time is lost.
      window.clearTimeout(dwellRef.current);
      flush(bookId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  return { updateProgress, resetSession, jumpBack, clearJumpBack };
}
