import type { Book } from "@/core/library";
import { BookTile } from "./book-tile";

export function LibraryGrid({
  books,
  openableIds,
  flashId,
  onOpenBook,
  onDetails,
  onRename,
  onChangeCover,
  onDelete,
}: {
  books: Book[];
  openableIds: Set<string>;
  flashId: string | null;
  onOpenBook: (id: string) => void;
  onDetails: (id: string) => void;
  onRename: (id: string) => void;
  onChangeCover: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-8 sm:grid-cols-4 lg:grid-cols-5">
      {books.map((book) => (
        <BookTile
          key={book.id}
          book={book}
          flash={flashId === book.id}
          onOpen={
            openableIds.has(book.id) ? () => onOpenBook(book.id) : undefined
          }
          onDetails={() => onDetails(book.id)}
          onRename={() => onRename(book.id)}
          onChangeCover={() => onChangeCover(book.id)}
          onDelete={() => onDelete(book.id)}
        />
      ))}
    </div>
  );
}
