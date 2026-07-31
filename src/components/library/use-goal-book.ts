import { useMemo, useRef, useState } from "react";
import type { Book } from "@/core/library";
import { charCountOfHtml } from "@/core/reading-stats";
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
// and cached (a full-book HTML parse is not free).
export function useGoalBook(
  books: Book[],
  getData: (id: string) => OpenedData | undefined,
  active: boolean,
) {
  const [goalBookId, setGoalBookId] = useState<string | null>(null);
  const charsCacheRef = useRef(new Map<string, number>());

  const goalBook = useMemo<GoalBook | undefined>(() => {
    if (!active || books.length === 0) return undefined;
    const chosen = goalBookId
      ? books.find((book) => book.id === goalBookId)
      : undefined;
    const current =
      chosen ??
      [...books].sort(
        (a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt),
      )[0];
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
    const data = getData(current.id);
    if (!data) return undefined;
    let totalChars = charsCacheRef.current.get(current.id);
    if (totalChars === undefined) {
      totalChars = data.chapters.reduce(
        (sum, chapter) => sum + charCountOfHtml(chapter.html),
        0,
      );
      charsCacheRef.current.set(current.id, totalChars);
    }
    return { id: current.id, title: current.title, totalChars, totalPages: 0 };
    // getData reads a stable ref map; books/active/goalBookId are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, books, goalBookId]);

  return { goalBook, setGoalBookId };
}
