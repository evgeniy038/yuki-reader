import { useEffect, useState, type ReactNode } from "react";
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
  loadBookData,
  onRenameBook,
  onDeleteBook,
  onRenameSeries,
  onDeleteSeries,
}: {
  books: Book[];
  loadBookData: (id: string) => Promise<OpenedData | undefined>;
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
  // A text book's chapter count and character total come from its content,
  // which loads on demand (the shelf keeps metadata only); the dialog opens
  // once they are in. Paged formats (PDF, manga) measure in pages and never
  // need the content.
  const detailsPaged =
    detailsBook?.format === "pdf" || detailsBook?.format === "manga";
  const [detailsCounts, setDetailsCounts] = useState<{
    id: string;
    chapters: number;
    chars: number;
  } | null>(null);
  useEffect(() => {
    if (!detailsId || detailsPaged) return;
    let alive = true;
    void loadBookData(detailsId).then((data) => {
      if (!alive || !data) return;
      setDetailsCounts({
        id: detailsId,
        chapters: data.chapters.length,
        chars: totalCharsOf(data),
      });
    });
    return () => {
      alive = false;
    };
    // loadBookData is rebuilt every render; the open dialog's id is the
    // real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsId, detailsPaged]);
  const counts = detailsCounts?.id === detailsId ? detailsCounts : null;

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
      {detailsBook && (detailsPaged || counts) ? (
        <BookDetailsDialog
          book={detailsBook}
          chapterCount={counts?.chapters ?? 0}
          totalChars={counts?.chars ?? 0}
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
