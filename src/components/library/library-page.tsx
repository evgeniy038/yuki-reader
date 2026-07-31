import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Plus } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  groupByLanguage,
  loadShelfSort,
  saveShelfSort,
  sortBooks,
  SHELF_SORTS,
  type Book,
  type ShelfSort,
} from "@/core/library";
import { blobToDataUrl } from "@/core/import-book";
import { charCountOfHtml } from "@/core/reading-stats";
import { Button } from "@/components/ui/button";
import { DashRing } from "@/components/ui/dash-ring";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LibraryGrid } from "./library-grid";
import { LibraryEmpty } from "./library-empty";
import {
  PageActions,
  PageContent,
  PageHeader,
  PageSectionTitle,
  PageShell,
  PageTitle,
} from "./page-shell";
import { RenameDialog } from "./rename-dialog";
import { BookDetailsDialog } from "./book-details-dialog";
import type { OpenedData } from "./use-shelf";

// The library page: shelf groups with language sections, the sort picker and
// the add button in the header (both hidden on the empty shelf — the empty
// state carries the add action), and every book-level dialog (rename,
// details, delete) — those are library concerns, so they live here with
// their hidden file inputs (book import, cover pick), not in the app shell.
export function LibraryPage({
  books,
  shelfReady,
  error,
  notice,
  flashId,
  dataRef,
  onOpenBook,
  onImportFile,
  onRenameBook,
  onDeleteBook,
  onChangeCover,
}: {
  books: Book[];
  shelfReady: boolean;
  error: string | null;
  notice: string | null;
  flashId: string | null;
  dataRef: { current: Map<string, OpenedData> };
  onOpenBook: (id: string) => void;
  onImportFile: (file: File) => void;
  onRenameBook: (id: string, title: string) => void;
  onDeleteBook: (id: string) => void;
  onChangeCover: (id: string, cover: string) => void;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<ShelfSort>(() => loadShelfSort());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const coverTargetRef = useRef<string | null>(null);

  useEffect(() => {
    saveShelfSort(sort);
  }, [sort]);

  // Sort options carry locale labels; the ids (SHELF_SORTS) stay in core.
  const sorts = useMemo(
    () =>
      SHELF_SORTS.map((item) => ({
        value: item.value,
        label: t(`library.sort.${item.value}`),
      })),
    [t],
  );

  const sorted = useMemo(() => sortBooks(books, sort), [books, sort]);
  const groups = useMemo(() => groupByLanguage(sorted), [sorted]);
  const showGroupHeaders = groups.length > 1;

  const groupLabel = (id: "ja" | "en" | "other") =>
    id === "ja" ? "日本語" : id === "en" ? "English" : t("library.other");

  const openableIds = useMemo(() => new Set(dataRef.current.keys()), [books]);

  const detailsBook = detailsId
    ? books.find((book) => book.id === detailsId)
    : undefined;
  const detailsTotalChars = useMemo(() => {
    if (!detailsId) return 0;
    const book = books.find((b) => b.id === detailsId);
    if (book?.format === "pdf") return 0; // PDF length is pages, not chars
    const data = dataRef.current.get(detailsId);
    if (!data) return 0;
    return data.chapters.reduce(
      (sum, chapter) => sum + charCountOfHtml(chapter.html),
      0,
    );
  }, [detailsId, books, dataRef]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onImportFile(file);
  };

  const pickCoverFor = (id: string) => {
    coverTargetRef.current = id;
    coverInputRef.current?.click();
  };

  const onCoverFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const id = coverTargetRef.current;
    coverTargetRef.current = null;
    if (!file || !id) return;
    void blobToDataUrl(file).then((cover) => onChangeCover(id, cover));
  };

  const saveRename = (title: string) => {
    const id = renamingId;
    setRenamingId(null);
    if (id) onRenameBook(id, title);
  };

  return (
    <PageShell>
      <PageHeader>
        <PageTitle>
          {t("library.title")} · {books.length}
        </PageTitle>
        {books.length > 0 ? (
          <PageActions>
            <Select
              items={sorts}
              value={sort}
              onValueChange={(value) => {
                if (value) setSort(value);
              }}
            >
              <SelectTrigger
                aria-label={t("library.sortAria")}
                className="border-0 bg-transparent px-2 shadow-none transition-colors hover:bg-hover-surface"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {sorts.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              <Plus />
              {t("library.addBook")}
            </Button>
          </PageActions>
        ) : null}
      </PageHeader>
      <PageContent>
        {error ? (
          <p className="mb-6 text-sm text-muted-content">{error}</p>
        ) : null}
        {notice ? (
          <p className="mb-6 text-sm text-muted-content">{notice}</p>
        ) : null}
        {books.length === 0 && !shelfReady ? (
          <div className="grid flex-1 place-items-center">
            <DashRing className="size-6 text-muted-content" />
          </div>
        ) : books.length === 0 ? (
          <LibraryEmpty onAdd={() => fileRef.current?.click()} />
        ) : (
          groups.map((group, index) => (
            <section
              key={group.id}
              className={index < groups.length - 1 ? "mb-10" : ""}
            >
              {showGroupHeaders ? (
                <PageSectionTitle>
                  {groupLabel(group.id)} · {group.books.length}
                </PageSectionTitle>
              ) : null}
              <LibraryGrid
                books={group.books}
                openableIds={openableIds}
                flashId={flashId}
                onOpenBook={onOpenBook}
                onDetails={setDetailsId}
                onRename={setRenamingId}
                onChangeCover={pickCoverFor}
                onDelete={setDeletingId}
              />
            </section>
          ))
        )}
      </PageContent>
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
        <AlertDialog
          open
          onOpenChange={(next) => !next && setDeletingId(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("library.delete.title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("library.delete.body", {
                  title: books.find((book) => book.id === deletingId)?.title ?? "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("library.delete.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onDeleteBook(deletingId);
                  setDeletingId(null);
                }}
              >
                {t("library.delete.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        hidden
        onChange={onFileChange}
      />
      <input
        ref={coverInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={onCoverFile}
      />
    </PageShell>
  );
}
