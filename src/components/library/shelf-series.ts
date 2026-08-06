import type { Dispatch, SetStateAction } from "react";
import type { Book } from "@/core/library";
import { cancelOcr } from "@/core/ocr/ocr";
import { deleteBook, updateBookMeta } from "@/core/storage";
import type { OpenedData } from "./use-shelf";

interface ShelfSeriesDeps {
  books: Book[];
  setBooks: Dispatch<SetStateAction<Book[]>>;
  dataRef: { current: Map<string, OpenedData> };
}

// Series-level shelf operations (rename, move, reorder, delete). Rebuilt
// every render off the current books — the methods read `books` directly
// (never inside setBooks updaters), fresh enough for an event-handler
// context.
export function createShelfSeries({
  books,
  setBooks,
  dataRef,
}: ShelfSeriesDeps) {
  // Rename every volume's series label.
  const renameSeries = (oldSeries: string, next: string) => {
    const ids = books
      .filter((book) => book.series === oldSeries)
      .map((book) => book.id);
    setBooks((prev) =>
      prev.map((book) =>
        book.series === oldSeries ? { ...book, series: next } : book,
      ),
    );
    for (const id of ids) void updateBookMeta(id, { series: next });
  };

  // Move one volume to another series (existing or new): it lands at the
  // end unless its own number is still free there.
  const moveVolumeToSeries = (id: string, series: string) => {
    const volume = books.find((book) => book.id === id);
    if (!volume || volume.series === series) return;
    const taken = new Set(
      books
        .filter((book) => book.series === series)
        .map((book) => book.volumeIndex),
    );
    const volumeIndex =
      volume.volumeIndex !== undefined && !taken.has(volume.volumeIndex)
        ? volume.volumeIndex
        : Math.max(0, ...[...taken].filter((n): n is number => n !== undefined)) + 1;
    setBooks((prev) =>
      prev.map((book) =>
        book.id === id ? { ...book, series, volumeIndex } : book,
      ),
    );
    void updateBookMeta(id, { series, volumeIndex });
  };

  // Move a whole series into another one (merge): volumes keep their numbers
  // where free, the rest land at the end in order.
  const moveSeries = (fromSeries: string, toSeries: string) => {
    if (fromSeries === toSeries) return;
    const taken = new Set(
      books
        .filter((book) => book.series === toSeries)
        .map((book) => book.volumeIndex),
    );
    let next =
      Math.max(0, ...[...taken].filter((n): n is number => n !== undefined)) + 1;
    const moving = books
      .filter((book) => book.series === fromSeries)
      .sort(
        (a, b) =>
          (a.volumeIndex ?? Infinity) - (b.volumeIndex ?? Infinity) ||
          a.addedAt - b.addedAt,
      );
    const assignments = new Map<string, { series: string; volumeIndex: number }>();
    for (const volume of moving) {
      let index = volume.volumeIndex;
      if (index === undefined || taken.has(index)) index = next++;
      taken.add(index);
      assignments.set(volume.id, { series: toSeries, volumeIndex: index });
    }
    setBooks((prev) =>
      prev.map((book) => {
        const patch = assignments.get(book.id);
        return patch ? { ...book, ...patch } : book;
      }),
    );
    assignments.forEach((patch, id) => void updateBookMeta(id, patch));
  };

  // Persist a manual reorder: positions become 1..n in the given id order.
  const setVolumeOrder = (orderedIds: string[]) => {
    setBooks((prev) =>
      prev.map((book) => {
        const index = orderedIds.indexOf(book.id);
        return index === -1 ? book : { ...book, volumeIndex: index + 1 };
      }),
    );
    orderedIds.forEach((id, index) => {
      void updateBookMeta(id, { volumeIndex: index + 1 });
    });
  };

  // Delete a whole series: every volume, pages included (deleteBook cascades).
  const removeSeries = (series: string) => {
    const ids = books
      .filter((book) => book.series === series)
      .map((book) => book.id);
    setBooks((prev) => prev.filter((book) => book.series !== series));
    for (const id of ids) {
      dataRef.current.delete(id);
      cancelOcr(id);
      void deleteBook(id);
    }
  };

  return {
    renameSeries,
    moveVolumeToSeries,
    moveSeries,
    setVolumeOrder,
    removeSeries,
  };
}
