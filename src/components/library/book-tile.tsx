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
import type { ReactNode } from "react";
import { useRef } from "react";
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

// How far from the pin's hit area the unpinned ribbon starts answering the
// pointer, px.
const PEEK_RADIUS = 112;

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
  // as an absolutely-positioned sibling over the cover's top-right corner.
  // It is ONE morphing element, not two skins: unpinned, the ribbon's
  // notched tip peeks from under the cover's top edge — and the CLOSER the
  // pointer gets, the further it peeks (proximity drives --peek, the 300ms
  // ease smooths every retarget). Pinning drops the ribbon to full length
  // on a light spring (a barely-there settle, never a visible dip below
  // the cover's edge); unpinning retracts it. All motion is a transform on
  // a promoted layer (no scale — a squashing ribbon reads as a glitch); the
  // hit area is a full 48px square. The clip window is 12px taller than the
  // ribbon so neither the spring's settle nor the press tug is cut flat.
  const pinButtonRef = useRef<HTMLButtonElement | null>(null);
  const ribbonRef = useRef<HTMLSpanElement | null>(null);
  const peekFrameRef = useRef(0);
  const handlePeekMove = (event: React.PointerEvent) => {
    if (!onToggleFavorite || book.favorite) return;
    const { clientX, clientY } = event;
    cancelAnimationFrame(peekFrameRef.current);
    peekFrameRef.current = requestAnimationFrame(() => {
      const button = pinButtonRef.current;
      const ribbon = ribbonRef.current;
      if (!button || !ribbon) return;
      const rect = button.getBoundingClientRect();
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      const t = Math.min(1, Math.max(0, 1 - Math.hypot(dx, dy) / PEEK_RADIUS));
      // smoothstep: the tip answers gently from afar, decisively up close.
      ribbon.style.setProperty("--peek", (t * t * (3 - 2 * t)).toFixed(3));
    });
  };
  const handlePeekLeave = () => {
    cancelAnimationFrame(peekFrameRef.current);
    // Remove (not zero) so the focus-visible variant can drive --peek again.
    ribbonRef.current?.style.removeProperty("--peek");
  };
  // Pressing the unpinned pin tugs the ribbon a hair past full reach.
  const handlePinPress = () => {
    if (!book.favorite)
      ribbonRef.current?.style.setProperty("--peek", "1.25");
  };
  const pinControl = onToggleFavorite ? (
    <button
      type="button"
      ref={pinButtonRef}
      data-book-favorite=""
      aria-label={t(book.favorite ? "library.menu.unpin" : "library.menu.pin")}
      aria-pressed={book.favorite}
      onPointerDown={handlePinPress}
      onClick={() => {
        // Clear the inline peek: the pinned classes ignore it, and after an
        // UNPIN the proximity handler must start from a clean slate.
        ribbonRef.current?.style.removeProperty("--peek");
        onToggleFavorite();
      }}
      className="group/pin absolute right-0 top-0 z-10 h-12 w-12 cursor-pointer"
    >
      <span className="absolute right-2.5 top-0 block h-12 w-7 overflow-hidden">
        <span
          ref={ribbonRef}
          className={`relative block h-9 w-7 bookmark-ribbon bg-primary-gradient will-change-transform transition-transform duration-300 ${
            book.favorite
              ? "translate-y-0 ease-[cubic-bezier(0.34,1.4,0.64,1)] group-active/pin:translate-y-[3px]"
              : "pin-peek ease-out group-focus-visible/pin:[--peek:1]"
          }`}
        >
          <Bookmark
            weight="fill"
            className={`relative mx-auto top-1.5 block size-4 text-white transition-[opacity,transform] duration-200 ${
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
    <div
      className="group relative transition-transform active:scale-98"
      onPointerMove={handlePeekMove}
      onPointerLeave={handlePeekLeave}
    >
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
