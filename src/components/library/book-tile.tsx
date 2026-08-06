import type { Book } from "@/core/library";
import { stateLabelOf } from "@/core/library";
import {
  BookOpen,
  Bookmark,
  Image,
  Info,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DashRing } from "@/components/ui/dash-ring";
import { BookCover, CoverFrame } from "./book-cover";

// A book on the shelf: cover, title, author, reading state (percent while
// reading, "Finished" at the end, silence for a fresh book). Click opens;
// right-click opens the context menu with every per-book action. Hover lifts
// the cover with a shadow.
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
  const stateLabel = stateLabelOf(book, t);
  const sub = subtitle ?? book.author ?? " ";
  const content = (
    <>
      <CoverFrame book={book} flash={flash}>
        <BookCover book={book} />
        {busy ? (
          <div
            data-ocr-gated=""
            className="absolute inset-0 grid place-items-center rounded-media bg-black/45 backdrop-blur-[2px]"
          >
            <DashRing className="size-6 text-white" />
          </div>
        ) : null}
      </CoverFrame>
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
  // as an absolutely-positioned sibling over the cover's top-right corner.
  // It is ONE morphing element, not two skins: unpinned, the ribbon hides
  // above the cover and its notched tip slides out on tile hover — already
  // the primary gradient, the bookmark is visibly THERE; pinning drops it
  // to full length on a light spring and fades the icon in, unpinning
  // retracts it. The pinned ribbon rests 13px INTO the clip — a hidden
  // reserve above the cover's edge: the spring's settle can only reveal
  // more ribbon, never open a gap at the seam. All motion is a transform
  // on a promoted layer (no scale — a squashing ribbon reads as a glitch);
  // the hit area is a full 56px square.
  const pinControl = onToggleFavorite ? (
    <button
      type="button"
      data-book-favorite=""
      aria-label={t(book.favorite ? "library.menu.unpin" : "library.menu.pin")}
      aria-pressed={book.favorite}
      onClick={onToggleFavorite}
      className="group/pin absolute right-0 top-0 z-10 h-14 w-14 cursor-pointer outline-none"
    >
      <span className="absolute right-2.5 top-0 block h-[52px] w-7 overflow-hidden">
        <span
          className={`relative block h-[54px] w-7 bookmark-ribbon bg-primary-gradient will-change-transform transition-transform duration-300 ${
            book.favorite
              ? "-translate-y-[13px] ease-[cubic-bezier(0.34,1.4,0.64,1)] group-active/pin:-translate-y-[10px] group-focus-visible/pin:-translate-y-[10px]"
              : "-translate-y-full ease-out group-hover:-translate-y-[30px] group-focus-visible/pin:-translate-y-[30px] group-active/pin:-translate-y-[26px]"
          }`}
        >
          <Bookmark
            weight="fill"
            className={`relative mx-auto top-[22px] block size-4 text-white transition-[opacity,transform] duration-200 ${
              book.favorite
                ? "translate-y-0 opacity-100 delay-100"
                : "-translate-y-1 opacity-0"
            }`}
          />
        </span>
      </span>
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
              className={`group flex w-full flex-col text-left ${
                busy ? "cursor-default" : "cursor-pointer"
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
