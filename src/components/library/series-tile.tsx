import type { ShelfItem } from "@/core/library";
import { readingStateOf, type Book } from "@/core/library";
import { BookOpen, PencilSimple, Trash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { BookCover } from "./book-cover";

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
  const pseudo: Book = {
    id: item.id,
    title: item.series,
    cover: item.cover,
    progress: item.progress,
    addedAt: item.addedAt,
  };
  const state = readingStateOf(pseudo);
  const stateLabel =
    state === "finished"
      ? t("library.finished")
      : state === "reading"
        ? `${Math.round(item.progress * 100)}%`
        : "";
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
        <div
          className={`rounded-media transition-shadow group-hover:shadow-floating ${
            flash ? "animate-pulse ring-2" : ""
          }`}
        >
          <BookCover book={pseudo} />
        </div>
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
