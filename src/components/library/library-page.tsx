import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
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
  type ShelfItem,
  type ShelfSort,
} from "@/core/library";
import { blobToDataUrl } from "@/core/import-book";
import type { MangaInputItem } from "@/core/import-manga";
import { charCountOfHtml } from "@/core/reading-stats";
import { cn } from "@/lib/utils";
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
import { CollapsibleShelf } from "./collapsible-shelf";
import {
  PageActions,
  PageContent,
  PageHeader,
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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [renamingSeries, setRenamingSeries] = useState<string | null>(null);
  const [deletingSeries, setDeletingSeries] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const coverTargetRef = useRef<string | null>(null);
  const dragGroupRef = useRef<string | null>(null);
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [ghostHeight, setGhostHeight] = useState(0);
  // Section elements by id ("__ghost" for the ghost slot) — the FLIP slide
  // measures and animates these directly.
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const flipTopsRef = useRef<Map<string, number> | null>(null);

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

  const registerSection = (id: string) => (el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(id, el);
    else sectionRefs.current.delete(id);
  };

  // FLIP: snapshot section tops BEFORE a layout-changing setState, then the
  // layout effect below slides every moved section from its old position.
  // The dragged section is skipped — it collapses in place, not slides.
  const snapshotTops = () => {
    const tops = new Map<string, number>();
    for (const [id, el] of sectionRefs.current) {
      if (id !== dragGroupRef.current) {
        tops.set(id, el.getBoundingClientRect().top);
      }
    }
    flipTopsRef.current = tops;
  };

  useLayoutEffect(() => {
    const tops = flipTopsRef.current;
    flipTopsRef.current = null;
    if (!tops || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    for (const [id, oldTop] of tops) {
      const el = sectionRefs.current.get(id);
      if (!el) continue;
      const delta = oldTop - el.getBoundingClientRect().top;
      if (delta === 0) continue;
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        { duration: 260, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
      );
    }
  });

  // Drag one group header onto another: the dragged section takes the
  // target's slot (the same splice idiom as the manga volume grid).
  const reorderGroups = (targetId: string) => {
    const fromId = dragGroupRef.current;
    dragGroupRef.current = null;
    setDragGroupId(null);
    setDropGroupId(null);
    if (!fromId || fromId === targetId) return;
    const ids: string[] = groups.map((group) => group.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, fromId);
    setGroupOrder(ids);
  };

  // The ghost slot marks where the dragged section would land: below the
  // hovered one on a downward drag (removal shifts later targets back one).
  const ghostIndex = (() => {
    if (!dragGroupId || !dropGroupId || dragGroupId === dropGroupId)
      return null;
    const ids: string[] = groups.map((group) => group.id);
    const from = ids.indexOf(dragGroupId);
    const to = ids.indexOf(dropGroupId);
    if (from === -1 || to === -1) return null;
    return from < to ? to + 1 : to;
  })();

  // Clear every drag artifact; the snapshot makes the restoration slide.
  const finishDrag = () => {
    if (!dragGroupRef.current) return;
    snapshotTops();
    dragGroupRef.current = null;
    setDragGroupId(null);
    setDropGroupId(null);
  };

  const sectionDrag = {
    onDragStart: (group: (typeof groups)[number], event: DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without data set on it.
      event.dataTransfer.setData("text/plain", group.id);
      dragGroupRef.current = group.id;
      snapshotTops();
      setGhostHeight(
        sectionRefs.current.get(group.id)?.getBoundingClientRect().height ?? 0,
      );
      setDragGroupId(group.id);
    },
    onDragOver: (group: (typeof groups)[number], event: DragEvent) => {
      if (!dragGroupRef.current || dragGroupRef.current === group.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropGroupId === group.id) return;
      snapshotTops();
      setDropGroupId(group.id);
    },
    // Drop lands on the list container: section drops bubble up to it, and
    // the pointer-transparent ghost lets events through to it — so the slot
    // marked at that moment is where the section goes. A drop with no slot
    // marked (or an Esc) just puts everything back.
    onContainerDragOver: (event: DragEvent) => {
      if (!dragGroupRef.current) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onContainerDrop: (event: DragEvent) => {
      if (!dragGroupRef.current) return;
      event.preventDefault();
      const targetId = dropGroupId;
      if (targetId && targetId !== dragGroupRef.current) {
        snapshotTops();
        reorderGroups(targetId);
      } else {
        finishDrag();
      }
    },
    onDragEnd: finishDrag,
  };

  const groupLabel = (id: "ja" | "en" | "other") =>
    id === "ja" ? "日本語" : id === "en" ? "English" : t("library.other");

  // Within a language section, manga series and books split into named
  // subsections (only when both kinds are present): native labels for
  // Japanese (小説 / 漫画), localized otherwise.
  const subLabel = (groupId: "ja" | "en" | "other", kind: "novels" | "manga") =>
    groupId === "ja"
      ? kind === "novels"
        ? "小説"
        : "漫画"
      : t(kind === "novels" ? "library.novels" : "library.manga");

  const openableIds = useMemo(() => new Set(dataRef.current.keys()), [books]);

  const detailsBook = detailsId
    ? books.find((book) => book.id === detailsId)
    : undefined;
  const detailsTotalChars = useMemo(() => {
    if (!detailsId) return 0;
    const book = books.find((b) => b.id === detailsId);
    if (book?.format === "pdf" || book?.format === "manga") return 0; // paged formats: length is pages, not chars
    const data = dataRef.current.get(detailsId);
    if (!data) return 0;
    return data.chapters.reduce(
      (sum, chapter) => sum + charCountOfHtml(chapter.html),
      0,
    );
  }, [detailsId, books, dataRef]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    onImportFiles(
      files.map((file) => ({
        file,
        path:
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name,
      })),
    );
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
          <div
            onDragOver={sectionDrag.onContainerDragOver}
            onDrop={sectionDrag.onContainerDrop}
          >
            {displayEntries.map((entry, index) => {
              if (entry.type === "ghost") {
                return (
                  <div
                    key="__ghost"
                    ref={registerSection("__ghost")}
                    aria-hidden
                    style={{ height: ghostHeight }}
                    className={cn(
                      "pointer-events-none flex animate-in fade-in-0 duration-150 items-center justify-center rounded-lg border border-dashed border-primary/40 bg-primary/5",
                      index < displayEntries.length - 1 && "mb-10",
                    )}
                  >
                    {dragGroup ? (
                      <span className="text-sm text-muted-content tabular-nums">
                        {groupLabel(dragGroup.id)} · {dragGroup.items.length}
                      </span>
                    ) : null}
                  </div>
                );
              }
              const group = entry.group;
              const novels = group.items.filter(
                ({ item }) => item.kind === "book",
              );
              const manga = group.items.filter(
                ({ item }) => item.kind === "series",
              );
              const subs = [
                { kind: "novels" as const, items: novels },
                { kind: "manga" as const, items: manga },
              ].filter((sub) => sub.items.length > 0);
              const gridFor = (entries: { item: ShelfItem }[]) => (
                <LibraryGrid
                  items={entries.map(({ item }) => item)}
                  openableIds={openableIds}
                  flashId={flashId}
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
              );
              // The group stack fans the first covers the flyers are measured
              // off — so both must follow the VISIBLE tiles (a collapsed
              // subsection has no tiles to fly from).
              const visibleItems = subs.flatMap((sub) =>
                collapsed.has(`${group.id}:${sub.kind}`)
                  ? []
                  : sub.items.map(({ item }) => item),
              );
              const allItems = subs.flatMap((sub) =>
                sub.items.map(({ item }) => item),
              );
              return (
                <section
                  key={group.id}
                  ref={registerSection(group.id)}
                  onDragOver={(event) => sectionDrag.onDragOver(group, event)}
                  className={cn(
                    index < displayEntries.length - 1 && "mb-10",
                    // The dragged section collapses out of the flow at once —
                    // the sections below slide up into its place (FLIP), and
                    // the ghost slot marks where it would land. It stays
                    // mounted: unmounting the drag source kills the session.
                    dragGroupId === group.id &&
                      "pointer-events-none absolute h-0 overflow-hidden opacity-0",
                  )}
                >
                  <CollapsibleShelf
                    level="group"
                    label={`${groupLabel(group.id)} · ${group.items.length}`}
                    collapsed={collapsed.has(group.id)}
                    onChange={(next) => toggleSection(group.id, next)}
                    items={visibleItems.length > 0 ? visibleItems : allItems}
                    headerDrag={
                      groups.length > 1
                        ? {
                            onDragStart: (event) =>
                              sectionDrag.onDragStart(group, event),
                            onDragEnd: sectionDrag.onDragEnd,
                          }
                        : undefined
                    }
                  >
                    {subs.map((sub, subIndex) =>
                      subs.length > 1 ? (
                        <CollapsibleShelf
                          key={sub.kind}
                          level="sub"
                          label={subLabel(group.id, sub.kind)}
                          collapsed={collapsed.has(`${group.id}:${sub.kind}`)}
                          onChange={(next) =>
                            toggleSection(`${group.id}:${sub.kind}`, next)
                          }
                          items={sub.items.map(({ item }) => item)}
                          className={subIndex < subs.length - 1 ? "mb-8" : ""}
                        >
                          {gridFor(sub.items)}
                        </CollapsibleShelf>
                      ) : (
                        <div key={sub.kind}>{gridFor(sub.items)}</div>
                      ),
                    )}
                  </CollapsibleShelf>
                </section>
              );
            })}
          </div>
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
      {deletingSeries ? (
        <AlertDialog
          open
          onOpenChange={(next) => !next && setDeletingSeries(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("library.delete.title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("manga.deleteSeries.body", { title: deletingSeries })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("library.delete.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onDeleteSeries(deletingSeries);
                  setDeletingSeries(null);
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
        accept=".epub,.pdf,.zip,.cbz,.mokuro,image/*,application/epub+zip,application/pdf"
        multiple
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
