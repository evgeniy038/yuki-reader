import type { ShelfItem } from "@/core/library";
import { coverBookOf, stateLabelOf } from "@/core/library";
import { BookOpen, Bookmark, PencilSimple, Trash } from "@/components/ui/icons";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { BookCover, CoverFrame } from "./book-cover";

type SeriesItem = Extract<ShelfItem, { kind: "series" }>;

// A manga series on the shelf: the earliest volume's cover, the series name,
// the volume count. Click opens the series page (the volume grid); right-click
// carries the series-level actions — rename (every volume follows) and delete
// (the whole series goes).
export function SeriesTile({
  item,
  flash = false,
  onOpen,
  onRename,
  onDelete,
}: {
  item: SeriesItem;
  flash?: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  // BookCover speaks Book — the series pretends to be one for the cover's sake.
  const pseudo = coverBookOf(item);
  const stateLabel = stateLabelOf(pseudo, t);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className="group flex w-full cursor-pointer flex-col text-left transition-transform active:scale-98"
            data-book-id={item.id}
          />
        }
      >
        <CoverFrame book={pseudo} flash={flash}>
          <BookCover book={pseudo} />
          {item.favorite ? (
            // A volume pinned from its series page hangs the ribbon here;
            // static (no flip) — the toggle lives on the volume tiles.
            <span
              data-book-favorite=""
              className="absolute right-2.5 top-0 block h-[41px] w-7 bg-primary-gradient bookmark-ribbon"
            >
              <Bookmark filled className="relative top-[9px] mx-auto size-4 text-white" />
            </span>
          ) : null}
        </CoverFrame>
        <p className="mt-3 truncate text-sm text-strong" title={item.series}>
          {item.series}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-content tabular-nums">
          {t("manga.volumeCount", { count: item.volumeCount })}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-content tabular-nums">
          {stateLabel || " "}
        </p>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <BookOpen />
          {t("library.menu.open")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onRename}>
          <PencilSimple />
          {t("library.menu.rename")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash />
          {t("library.menu.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
