import type { Book } from "@/core/library";
import { readingStateOf } from "@/core/library";
import {
  BookOpen,
  Bookmark,
  Image,
  Info,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DashRing } from "@/components/ui/dash-ring";
import { ProgressRing } from "@/components/ui/progress-ring";
import { BookCover } from "./book-cover";

// A book on the shelf: cover, title, author, reading state (percent while
// reading, "Finished" at the end, silence for a fresh book). Click opens;
// right-click opens the context menu with every per-book action. Hover lifts
// the cover with a shadow, press settles the tile.
// `subtitle` overrides the author line (manga volumes show "Vol N" there);
// `menuExtra` inserts extra context-menu items before the destructive zone.
// `busy` (manga volumes mid-detect) frosts the cover with a spinner — the
// volume can't be opened until its pages have OCR boxes.
export function BookTile({
  book,
  flash = false,
  busy = false,
  subtitle,
  menuExtra,
  onOpen,
  onDetails,
  onRename,
  onChangeCover,
  onDelete,
  onToggleFavorite,
}: {
  book: Book;
  flash?: boolean;
  busy?: boolean;
  subtitle?: string;
  menuExtra?: ReactNode;
  onOpen?: () => void;
  onDetails?: () => void;
  onRename?: () => void;
  onChangeCover?: () => void;
  onDelete?: () => void;
  /** Shows the pin control on the cover (hover to pin; pinned = ribbon). */
  onToggleFavorite?: () => void;
}) {
  const { t } = useTranslation();
  // Flip the ribbon in only on a real pin action during this tile's life —
  // never on mount, or every library visit would replay it for every pin.
  const [justPinned, setJustPinned] = useState(false);
  const prevFavoriteRef = useRef(book.favorite);
  useEffect(() => {
    if (book.favorite && !prevFavoriteRef.current) setJustPinned(true);
    prevFavoriteRef.current = book.favorite;
  }, [book.favorite]);
  // Unpin lets the ribbon swing back over the edge before the state flips —
  // the exit mirrors the entrance path, faster.
  const [leaving, setLeaving] = useState(false);
  const leaveTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(leaveTimerRef.current), []);
  const state = readingStateOf(book);
  const stateLabel =
    state === "finished"
      ? t("library.finished")
      : state === "reading"
        ? `${Math.round(book.progress * 100)}%`
        : "";
  const sub = subtitle ?? book.author ?? " ";
  const content = (
    <>
      <div
        className={`relative rounded-media transition-shadow group-hover:shadow-floating ${
          flash ? "animate-pulse ring-2" : ""
        }`}
      >
        <BookCover book={book} />
        {busy ? (
          <div
            data-ocr-gated=""
            className="absolute inset-0 grid place-items-center rounded-media bg-black/45 backdrop-blur-[2px]"
          >
            <DashRing className="size-6 text-white" />
          </div>
        ) : null}
        {book.progress > 0 ? (
          <div
            data-book-progress=""
            className="absolute bottom-1.5 right-1.5 rounded-full bg-scrim p-1"
          >
            <ProgressRing value={book.progress} className="size-6" />
          </div>
        ) : null}
      </div>
      <p className="mt-3 truncate text-sm text-strong" title={book.title}>
        {book.title}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-content" title={subtitle ? undefined : (book.author ?? undefined)}>
        {sub}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-content tabular-nums">
        {busy ? t("ocr.stage.detect") : stateLabel || " "}
      </p>
    </>
  );
  if (!onOpen) {
    return (
      <div
        className="flex w-full flex-col text-left"
        data-book-id={book.id}
      >
        {content}
      </div>
    );
  }
  // The pin control can't nest inside the tile's own <button>, so it rides
  // as an absolutely-positioned sibling over the cover's top-right corner:
  // a hover-revealed outline bookmark when unpinned, the ribbon itself when
  // pinned — the ribbon is the unpin button. The hit area is a full 48px
  // square; the visuals are smaller and centered inside it.
  const handlePinClick = () => {
    if (!onToggleFavorite) return;
    if (!book.favorite) {
      onToggleFavorite();
      return;
    }
    setLeaving(true);
    leaveTimerRef.current = window.setTimeout(() => {
      setLeaving(false);
      onToggleFavorite();
    }, 200);
  };
  const pinControl = onToggleFavorite ? (
    <button
      type="button"
      data-book-favorite=""
      aria-label={t(book.favorite ? "library.menu.unpin" : "library.menu.pin")}
      aria-pressed={book.favorite}
      onClick={handlePinClick}
      className={`absolute right-0 top-0 z-10 flex h-12 w-12 cursor-pointer items-start justify-center pin-toggle-transition active:scale-90 ${
        book.favorite
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      }`}
    >
      {book.favorite ? (
        <span
          className={`block h-9 w-7 bg-primary-gradient bookmark-ribbon ${
            leaving ? "bookmark-flip-out" : justPinned ? "bookmark-flip" : ""
          }`}
        >
          <Bookmark weight="fill" className="mx-auto mt-1.5 size-4 text-white" />
        </span>
      ) : (
        <span className="mt-1.5 grid size-9 place-items-center rounded-full bg-scrim">
          <Bookmark weight="bold" className="size-5 text-white" />
        </span>
      )}
    </button>
  ) : null;
  return (
    <div className="group relative">
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              onClick={onOpen}
              aria-disabled={busy || undefined}
              className={`group flex w-full flex-col text-left transition-transform ${
                busy ? "cursor-default" : "cursor-pointer active:scale-98"
              }`}
              data-book-id={book.id}
            />
          }
        >
          {content}
        </ContextMenuTrigger>
        <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <BookOpen />
          {t("library.menu.open")}
        </ContextMenuItem>
        {onDetails ? (
          <ContextMenuItem onClick={onDetails}>
            <Info />
            {t("library.menu.details")}
          </ContextMenuItem>
        ) : null}
        {onRename ? (
          <ContextMenuItem onClick={onRename}>
            <PencilSimple />
            {t("library.menu.rename")}
          </ContextMenuItem>
        ) : null}
        {onChangeCover ? (
          <ContextMenuItem onClick={onChangeCover}>
            <Image />
            {t("library.menu.cover")}
          </ContextMenuItem>
        ) : null}
        {menuExtra}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash />
          {t("library.menu.delete")}
        </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinControl}
    </div>
  );
}
