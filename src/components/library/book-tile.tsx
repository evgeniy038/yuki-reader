import type { Book } from "@/core/library";
import { readingStateOf } from "@/core/library";
import { BookOpen, Image, Info, PencilSimple, Trash } from "@phosphor-icons/react";
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
}) {
  const { t } = useTranslation();
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
  return (
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
  );
}
