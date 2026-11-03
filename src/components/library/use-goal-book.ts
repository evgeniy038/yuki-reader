import { useEffect, useMemo, useState } from "react";
import type { Book } from "@/core/library";
import { totalCharsOf } from "@/core/reading-stats";
import type { OpenedData } from "./use-shelf";

/** The book a percent daily goal scales from. */
export interface GoalBook {
  id: string;
  title: string;
  totalChars: number;
  totalPages: number;
}

// The stats view's "8 % от …" book: the user picks it themselves (goalBookId);
// unset or deleted → the current read. Char totals are counted once per book
// and cached (a full-book HTML parse is not free); the book's content loads
// on demand — the shelf keeps metadata only.
export function useGoalBook(
  books: Book[],
  loadData: (id: string) => Promise<OpenedData | undefined>,
  active: boolean,
) {
  const [goalBookId, setGoalBookId] = useState<string | null>(null);
  const [chars, setChars] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const current = useMemo(() => {
    if (!active || books.length === 0) return undefined;
    const chosen = goalBookId
      ? books.find((book) => book.id === goalBookId)
      : undefined;
    return (
      chosen ??
      [...books].sort(
        (a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt),
      )[0]
    );
  }, [active, books, goalBookId]);

  const countId =
    current && current.format !== "pdf" && !chars.has(current.id)
      ? current.id
      : null;
  useEffect(() => {
    if (!countId) return;
    let alive = true;
    void loadData(countId).then((data) => {
      if (!alive || !data) return;
      const total = totalCharsOf(data);
      setChars((prev) => new Map(prev).set(countId, total));
    });
    return () => {
      alive = false;
    };
    // loadData is rebuilt every render; the book id is the real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countId]);

  const goalBook = useMemo<GoalBook | undefined>(() => {
    if (!current) return undefined;
    if (current.format === "pdf") {
      // PDF length is pages, not chars.
      return {
        id: current.id,
        title: current.title,
        totalChars: 0,
        totalPages: current.pageCount ?? 0,
      };
    }
    const totalChars = chars.get(current.id);
    if (totalChars === undefined) return undefined;
    return { id: current.id, title: current.title, totalChars, totalPages: 0 };
  }, [current, chars]);

  return { goalBook, setGoalBookId };
}
