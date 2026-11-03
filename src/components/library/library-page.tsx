import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Plus } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  buildShelfItems,
  groupByLanguage,
  loadShelfCollapsed,
  loadShelfGroupOrder,
  loadShelfSort,
  saveShelfCollapsed,
  saveShelfGroupOrder,
  saveShelfSort,
  sortBooks,
  SHELF_SORTS,
  type Book,
  type ShelfSort,
} from "@/core/library";
import { blobToDataUrl } from "@/core/import-book";
import type { MangaInputItem } from "@/core/import-manga";
import { importItemsOf } from "@/lib/import-files";
import { Button } from "@/components/ui/button";
import { DashRing } from "@/components/ui/dash-ring";
import { HiddenFileInput } from "@/components/ui/hidden-file-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LibraryEmpty } from "./library-empty";
import {
  PageActions,
  PageContent,
  PageHeader,
  PageShell,
  PageTitle,
} from "./page-shell";
import { PageMessages } from "./page-messages";
import { ShelfGhostSlot, ShelfGroup, shelfGroupLabel } from "./shelf-group";
import { useGroupReorder } from "./use-group-reorder";
import { useLibraryDialogs } from "./library-dialogs";
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
  onImportFiles,
  onRenameBook,
  onDeleteBook,
  onChangeCover,
  onToggleFavorite,
  onOpenSeries,
  onRenameSeries,
  onDeleteSeries,
}: {
  books: Book[];
  shelfReady: boolean;
  error: string | null;
  notice: string | null;
  flashId: string | null;
  dataRef: { current: Map<string, OpenedData> };
  onOpenBook: (id: string) => void;
  onImportFiles: (items: MangaInputItem[]) => void;
  onRenameBook: (id: string, title: string) => void;
  onDeleteBook: (id: string) => void;
  onChangeCover: (id: string, cover: string) => void;
  onToggleFavorite: (id: string) => void;
  onOpenSeries: (series: string) => void;
  onRenameSeries: (series: string, next: string) => void;
  onDeleteSeries: (series: string) => void;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<ShelfSort>(() => loadShelfSort());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(loadShelfCollapsed()),
  );
  // Empty = the default ja → en → other order (nothing saved yet).
  const [groupOrder, setGroupOrder] = useState<string[]>(
    () => loadShelfGroupOrder() ?? [],
  );
  const {
    dialogs,
    setRenamingId,
    setDeletingId,
    setDetailsId,
    setRenamingSeries,
    setDeletingSeries,
  } = useLibraryDialogs({
    books,
    dataRef,
    onRenameBook,
    onDeleteBook,
    onRenameSeries,
    onDeleteSeries,
  });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const coverTargetRef = useRef<string | null>(null);

  useEffect(() => {
    saveShelfSort(sort);
  }, [sort]);

  useEffect(() => {
    saveShelfCollapsed([...collapsed]);
  }, [collapsed]);

  useEffect(() => {
    if (groupOrder.length > 0) saveShelfGroupOrder(groupOrder);
  }, [groupOrder]);

  // Section ids: the language group ("ja") or a kind subsection inside it
  // ("ja:novels" / "ja:manga").
  const toggleSection = (id: string, next: boolean) => {
    setCollapsed((prev) => {
      const s = new Set(prev);
      if (next) s.add(id);
      else s.delete(id);
      return s;
    });
  };

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
  const items = useMemo(() => buildShelfItems(sorted), [sorted]);
  const groups = useMemo(
    () =>
      groupByLanguage(
        items.map((item) => ({
          item,
          language: item.kind === "series" ? item.language : item.book.language,
        })),
        groupOrder.length > 0 ? groupOrder : undefined,
      ),
    [items, groupOrder],
  );

  const { dragGroupId, ghostHeight, ghostIndex, registerSection, sectionDrag } =
    useGroupReorder({ groups, onReorder: setGroupOrder });

  const openableIds = useMemo(() => new Set(dataRef.current.keys()), [books]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    onImportFiles(importItemsOf(files));
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

  // Sections in display order plus the ghost slot (when a drag hovers a
  // target). Keys stay stable, so the dragged section's DOM node — and the
  // drag session — survives the ghost appearing next to it.
  type DisplayEntry =
    | { type: "group"; group: (typeof groups)[number] }
    | { type: "ghost" };
  const displayEntries: DisplayEntry[] = groups.map((group) => ({
    type: "group",
    group,
  }));
  if (ghostIndex !== null) {
    displayEntries.splice(Math.min(ghostIndex, displayEntries.length), 0, {
      type: "ghost",
    });
  }
  const dragGroup = dragGroupId
    ? groups.find((group) => group.id === dragGroupId)
    : undefined;

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
            <Button
              size="sm"
              onClick={() => fileRef.current?.click()}
              aria-label={t("library.addBook")}
            >
              <Plus />
              <span className="max-xs:sr-only">{t("library.addBook")}</span>
            </Button>
          </PageActions>
        ) : null}
      </PageHeader>
      <PageContent>
        <PageMessages error={error} notice={notice} />
        {books.length === 0 && !shelfReady ? (
          <div className="grid flex-1 place-items-center">
            <DashRing className="size-6 text-muted-content" />
          </div>
        ) : books.length === 0 ? (
          <LibraryEmpty onAdd={() => fileRef.current?.click()} />
        ) : (
          <div
            onDragOver={sectionDrag.onContainerDragOver}
            onDrop={sectionDrag.onContainerDrop}
          >
            {displayEntries.map((entry, index) =>
              entry.type === "ghost" ? (
                <ShelfGhostSlot
                  key="__ghost"
                  ghostHeight={ghostHeight}
                  label={
                    dragGroup
                      ? `${shelfGroupLabel(t, dragGroup.id)} · ${dragGroup.items.length}`
                      : null
                  }
                  isLast={index === displayEntries.length - 1}
                  registerSection={registerSection}
                />
              ) : (
                <ShelfGroup
                  key={entry.group.id}
                  group={entry.group}
                  groupsCount={groups.length}
                  isLast={index === displayEntries.length - 1}
                  collapsed={collapsed}
                  onToggleSection={toggleSection}
                  openableIds={openableIds}
                  flashId={flashId}
                  registerSection={registerSection}
                  sectionDrag={sectionDrag}
                  dragGroupId={dragGroupId}
                  onOpenBook={onOpenBook}
                  onDetails={setDetailsId}
                  onRename={setRenamingId}
                  onChangeCover={pickCoverFor}
                  onDelete={setDeletingId}
                  onToggleFavorite={onToggleFavorite}
                  onOpenSeries={onOpenSeries}
                  onRenameSeries={setRenamingSeries}
                  onDeleteSeries={setDeletingSeries}
                />
              ),
            )}
          </div>
        )}
      </PageContent>
      {dialogs}
      <HiddenFileInput
        inputRef={fileRef}
        accept=".epub,.pdf,.zip,.cbz,.mokuro,image/*,application/epub+zip,application/pdf"
        multiple
        onChange={onFileChange}
      />
      <HiddenFileInput
        inputRef={coverInputRef}
        accept="image/*"
        onChange={onCoverFile}
      />
    </PageShell>
  );
}
