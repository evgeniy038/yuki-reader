import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Book } from "@/core/library";
import { totalCharsOf } from "@/core/reading-stats";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RenameDialog } from "./rename-dialog";
import { BookDetailsDialog } from "./book-details-dialog";
import type { OpenedData } from "./use-shelf";

// Every book-level dialog of the library page (rename, series rename,
// details, delete, series delete) with the states that open them — the page
// wires the returned setters into the grid's context menus and renders
// `dialogs` next to its hidden file inputs.
export function useLibraryDialogs({
  books,
  dataRef,
  onRenameBook,
  onDeleteBook,
  onRenameSeries,
  onDeleteSeries,
}: {
  books: Book[];
  dataRef: { current: Map<string, OpenedData> };
  onRenameBook: (id: string, title: string) => void;
  onDeleteBook: (id: string) => void;
  onRenameSeries: (series: string, next: string) => void;
  onDeleteSeries: (series: string) => void;
}): {
  dialogs: ReactNode;
  setRenamingId: (id: string | null) => void;
  setDeletingId: (id: string | null) => void;
  setDetailsId: (id: string | null) => void;
  setRenamingSeries: (series: string | null) => void;
  setDeletingSeries: (series: string | null) => void;
} {
  const { t } = useTranslation();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [renamingSeries, setRenamingSeries] = useState<string | null>(null);
  const [deletingSeries, setDeletingSeries] = useState<string | null>(null);

  const detailsBook = detailsId
    ? books.find((book) => book.id === detailsId)
    : undefined;
  const detailsTotalChars = useMemo(() => {
    if (!detailsId) return 0;
    const book = books.find((b) => b.id === detailsId);
    if (book?.format === "pdf" || book?.format === "manga") return 0; // paged formats: length is pages, not chars
    const data = dataRef.current.get(detailsId);
    if (!data) return 0;
    return totalCharsOf(data);
  }, [detailsId, books, dataRef]);

  const saveRename = (title: string) => {
    const id = renamingId;
    setRenamingId(null);
    if (id) onRenameBook(id, title);
  };

  const dialogs = (
    <>
      {renamingId ? (
        <RenameDialog
          open
          initialTitle={
            books.find((book) => book.id === renamingId)?.title ?? ""
          }
          onSave={saveRename}
          onClose={() => setRenamingId(null)}
        />
      ) : null}
      {renamingSeries ? (
        <RenameDialog
          open
          initialTitle={renamingSeries}
          onSave={(next) => {
            onRenameSeries(renamingSeries, next);
            setRenamingSeries(null);
          }}
          onClose={() => setRenamingSeries(null)}
        />
      ) : null}
      {detailsBook ? (
        <BookDetailsDialog
          book={detailsBook}
          chapterCount={
            dataRef.current.get(detailsBook.id)?.chapters.length ?? 0
          }
          totalChars={detailsTotalChars}
          onClose={() => setDetailsId(null)}
        />
      ) : null}
      {deletingId ? (
        <ConfirmDialog
          open
          title={t("library.delete.title")}
          body={t("library.delete.body", {
            title: books.find((book) => book.id === deletingId)?.title ?? "",
          })}
          onConfirm={() => onDeleteBook(deletingId)}
          onClose={() => setDeletingId(null)}
        />
      ) : null}
      {deletingSeries ? (
        <ConfirmDialog
          open
          title={t("library.delete.title")}
          body={t("manga.deleteSeries.body", { title: deletingSeries })}
          onConfirm={() => onDeleteSeries(deletingSeries)}
          onClose={() => setDeletingSeries(null)}
        />
      ) : null}
    </>
  );

  return {
    dialogs,
    setRenamingId,
    setDeletingId,
    setDetailsId,
    setRenamingSeries,
    setDeletingSeries,
  };
}
