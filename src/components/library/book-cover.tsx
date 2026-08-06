import type { ReactNode } from "react";
import type { Book } from "@/core/library";
import { ProgressRing } from "@/components/ui/progress-ring";

// A book cover on the shelf: the real EPUB cover image when we have one, else a
// quiet neutral placeholder carrying the title + author. The image gets a
// hairline inset outline so light covers don't bleed into the white card.
export function BookCover({ book }: { book: Book }) {
  if (book.cover) {
    return (
      <img
        src={book.cover}
        alt={book.title}
        className="aspect-2/3 w-full rounded-media object-cover outline -outline-offset-1 outline-black/10"
      />
    );
  }
  return (
    <div className="flex aspect-2/3 flex-col items-center justify-center gap-1 rounded-media bg-muted-surface px-3 text-center">
      <p className="line-clamp-3 text-sm font-medium text-strong">{book.title}</p>
      {book.author ? (
        <p className="line-clamp-1 text-xs text-muted-content">{book.author}</p>
      ) : null}
    </div>
  );
}

// The cover's tile frame: relative positioning for the overlays riding on the
// cover, the hover lift shadow, an optional flash pulse, and the
// reading-progress ring parked on the bottom-right corner.
export function CoverFrame({
  book,
  flash = false,
  children,
}: {
  book: Book;
  flash?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`relative rounded-media transition-shadow group-hover:shadow-floating ${
        flash ? "animate-pulse ring-2" : ""
      }`}
    >
      {children}
      {book.progress > 0 ? (
        <div
          data-book-progress=""
          className="absolute bottom-1.5 right-1.5 rounded-full bg-scrim p-1"
        >
          <ProgressRing value={book.progress} className="size-6" />
        </div>
      ) : null}
    </div>
  );
}
