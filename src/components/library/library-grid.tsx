import { Star } from "@/components/ui/icons";
import { useTranslation } from "react-i18next";
import type { ShelfItem } from "@/core/library";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { BookTile } from "./book-tile";
import { SeriesTile } from "./series-tile";

// The shelf grid geometry, shared with the collapsed-section cover stack so
// the stack lands exactly in the first cell.
export const GRID_CLASSES =
  "grid grid-cols-3 gap-x-4 gap-y-8 sm:grid-cols-4 lg:grid-cols-5";

export function LibraryGrid({
  items,
  flashId,
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
  items: ShelfItem[];
  flashId: string | null;
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
  return (
    <div className={GRID_CLASSES}>
      {items.map((item) =>
        item.kind === "series" ? (
          <SeriesTile
            key={item.id}
            item={item}
            flash={flashId === item.id}
            onOpen={() => onOpenSeries(item.series)}
            onRename={() => onRenameSeries(item.series)}
            onDelete={() => onDeleteSeries(item.series)}
          />
        ) : (
          <BookTile
            key={item.book.id}
            book={item.book}
            flash={flashId === item.book.id}
            onOpen={() => onOpenBook(item.book.id)}
            onDetails={() => onDetails(item.book.id)}
            onRename={() => onRename(item.book.id)}
            onChangeCover={() => onChangeCover(item.book.id)}
            onDelete={() => onDelete(item.book.id)}
            onToggleFavorite={() => onToggleFavorite(item.book.id)}
            menuExtra={
              <ContextMenuItem onClick={() => onToggleFavorite(item.book.id)}>
                <Star filled={item.book.favorite} />
                {t(item.book.favorite ? "library.menu.unpin" : "library.menu.pin")}
              </ContextMenuItem>
            }
          />
        ),
      )}
    </div>
  );
}
