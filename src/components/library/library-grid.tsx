import type { ShelfItem } from "@/core/library";
import { BookTile } from "./book-tile";
import { SeriesTile } from "./series-tile";

// The shelf grid geometry, shared with the collapsed-section cover stack so
// the stack lands exactly in the first cell.
export const GRID_CLASSES =
  "grid grid-cols-3 gap-x-4 gap-y-8 sm:grid-cols-4 lg:grid-cols-5";

export function LibraryGrid({
  items,
  openableIds,
  flashId,
  onOpenBook,
  onDetails,
  onRename,
  onChangeCover,
  onDelete,
  onOpenSeries,
  onRenameSeries,
  onDeleteSeries,
}: {
  items: ShelfItem[];
  openableIds: Set<string>;
  flashId: string | null;
  onOpenBook: (id: string) => void;
  onDetails: (id: string) => void;
  onRename: (id: string) => void;
  onChangeCover: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSeries: (series: string) => void;
  onRenameSeries: (series: string) => void;
  onDeleteSeries: (series: string) => void;
}) {
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
            onOpen={
              openableIds.has(item.book.id)
                ? () => onOpenBook(item.book.id)
                : undefined
            }
            onDetails={() => onDetails(item.book.id)}
            onRename={() => onRename(item.book.id)}
            onChangeCover={() => onChangeCover(item.book.id)}
            onDelete={() => onDelete(item.book.id)}
          />
        ),
      )}
    </div>
  );
}
