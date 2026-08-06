import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ShelfItem } from "@/core/library";
import { cn } from "@/lib/utils";
import { CollapsibleShelf } from "./collapsible-shelf";
import { LibraryGrid } from "./library-grid";
import type { SectionDrag } from "./use-group-reorder";

// The language group header label: native names for ja/en, localized for the
// rest.
export function shelfGroupLabel(
  t: TFunction,
  id: "ja" | "en" | "other",
): string {
  return id === "ja" ? "日本語" : id === "en" ? "English" : t("library.other");
}

// Within a language section, manga series and books split into named
// subsections (only when both kinds are present): native labels for
// Japanese (小説 / 漫画), localized otherwise.
function shelfSubLabel(
  t: TFunction,
  groupId: "ja" | "en" | "other",
  kind: "novels" | "manga",
): string {
  return groupId === "ja"
    ? kind === "novels"
      ? "小説"
      : "漫画"
    : t(kind === "novels" ? "library.novels" : "library.manga");
}

// The ghost slot of a group drag: a dashed placeholder the dragged section
// would land at, holding the dragged group's label.
export function ShelfGhostSlot({
  ghostHeight,
  label,
  isLast,
  registerSection,
}: {
  ghostHeight: number;
  /** "日本語 · 12" for the dragged group, when one is in flight. */
  label: string | null;
  isLast: boolean;
  registerSection: (id: string) => (el: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={registerSection("__ghost")}
      aria-hidden
      style={{ height: ghostHeight }}
      className={cn(
        "pointer-events-none flex animate-in fade-in-0 duration-150 items-center justify-center rounded-lg border border-dashed border-primary/40 bg-primary/5",
        !isLast && "mb-10",
      )}
    >
      {label ? (
        <span className="text-sm text-muted-content tabular-nums">{label}</span>
      ) : null}
    </div>
  );
}

// One language group on the shelf: its <section> (the FLIP/drag node — the
// ref registration and the collapse class are load-bearing) with the
// collapsible header and the novels/manga subsections inside.
export function ShelfGroup({
  group,
  groupsCount,
  isLast,
  collapsed,
  onToggleSection,
  openableIds,
  flashId,
  registerSection,
  sectionDrag,
  dragGroupId,
  onOpenBook,
  onDetails,
  onRename,
  onChangeCover,
  onDelete,
  onToggleFavorite,
  onOpenSeries,
  onRenameSeries,
  onDeleteSeries,
}: {
  group: { id: "ja" | "en" | "other"; items: { item: ShelfItem }[] };
  groupsCount: number;
  isLast: boolean;
  collapsed: ReadonlySet<string>;
  onToggleSection: (id: string, next: boolean) => void;
  openableIds: Set<string>;
  flashId: string | null;
  registerSection: (id: string) => (el: HTMLElement | null) => void;
  sectionDrag: SectionDrag;
  dragGroupId: string | null;
  onOpenBook: (id: string) => void;
  onDetails: (id: string) => void;
  onRename: (id: string) => void;
  onChangeCover: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onOpenSeries: (series: string) => void;
  onRenameSeries: (series: string) => void;
  onDeleteSeries: (series: string) => void;
}) {
  const { t } = useTranslation();
  const novels = group.items.filter(({ item }) => item.kind === "book");
  const manga = group.items.filter(({ item }) => item.kind === "series");
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
      onDetails={onDetails}
      onRename={onRename}
      onChangeCover={onChangeCover}
      onDelete={onDelete}
      onToggleFavorite={onToggleFavorite}
      onOpenSeries={onOpenSeries}
      onRenameSeries={onRenameSeries}
      onDeleteSeries={onDeleteSeries}
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
  const allItems = subs.flatMap((sub) => sub.items.map(({ item }) => item));
  return (
    <section
      ref={registerSection(group.id)}
      onDragOver={(event) => sectionDrag.onDragOver(group, event)}
      className={cn(
        !isLast && "mb-10",
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
        label={`${shelfGroupLabel(t, group.id)} · ${group.items.length}`}
        collapsed={collapsed.has(group.id)}
        onChange={(next) => onToggleSection(group.id, next)}
        items={visibleItems.length > 0 ? visibleItems : allItems}
        headerDrag={
          groupsCount > 1
            ? {
                onDragStart: (event) => sectionDrag.onDragStart(group, event),
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
              label={shelfSubLabel(t, group.id, sub.kind)}
              collapsed={collapsed.has(`${group.id}:${sub.kind}`)}
              onChange={(next) => onToggleSection(`${group.id}:${sub.kind}`, next)}
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
}
