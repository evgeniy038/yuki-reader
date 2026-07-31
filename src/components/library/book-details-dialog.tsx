import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Book } from "@/core/library";
import { loadBookStats, type BookAmount } from "@/core/storage";
import { formatDateLong, formatDuration, formatNumber, speedLabel } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookCover } from "./book-cover";

const LANGUAGE_LABELS = { ja: "日本語", en: "English" } as const;

// Book details ("Details" from the tile's context menu): everything we know
// about the book that doesn't fit on the tile — including its own reading
// history (volume, time, speed). Facts only, no actions.
export function BookDetailsDialog({
  book,
  chapterCount,
  totalChars,
  onClose,
}: {
  book: Book;
  chapterCount: number;
  totalChars: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reading, setReading] = useState<BookAmount | null>(null);

  useEffect(() => {
    let alive = true;
    void loadBookStats(book.id).then((amount) => {
      if (alive) setReading(amount);
    });
    return () => {
      alive = false;
    };
  }, [book.id]);

  const pct = Math.round(book.progress * 100);
  const isPaged = book.format === "pdf" || book.format === "manga";
  const lengthRow: [string, string] = isPaged
    ? [t("details.pages"), book.pageCount != null ? String(book.pageCount) : "—"]
    : [t("details.chapters"), String(chapterCount)];
  const hasReading =
    reading !== null && reading.chars + reading.pages + reading.timeMs > 0;
  const speed = reading ? speedLabel(reading) : null;
  const rows: [string, string][] = [
    [t("details.name"), book.title],
    [t("details.author"), book.author ?? "—"],
    [t("details.language"), book.language ? LANGUAGE_LABELS[book.language] : "—"],
    [t("details.format"), book.format ?? "—"],
    lengthRow,
    ...(totalChars > 0
      ? [[t("details.chars"), formatNumber(totalChars)] as [string, string]]
      : []),
    [t("details.progress"), pct >= 100 ? t("library.finished") : `${pct}%`],
    ...(hasReading && reading.chars > 0
      ? [
          [
            t("details.charsRead"),
            formatNumber(reading.chars),
          ] as [string, string],
        ]
      : []),
    ...(hasReading && reading.pages > 0
      ? [
          [
            t("details.pagesRead"),
            formatNumber(reading.pages),
          ] as [string, string],
        ]
      : []),
    ...(hasReading
      ? [[t("details.time"), formatDuration(reading.timeMs)] as [string, string]]
      : []),
    ...(speed !== null ? [[t("details.speed"), speed] as [string, string]] : []),
    [t("details.added"), formatDateLong(book.addedAt)],
    [t("details.lastRead"), book.lastReadAt ? formatDateLong(book.lastReadAt) : "—"],
  ];
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("details.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex gap-4">
          <div className="w-20 shrink-0">
            <BookCover book={book} />
          </div>
          <dl className="flex min-w-0 flex-1 flex-col gap-1.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4">
                <dt className="shrink-0 text-xs text-muted-content">{label}</dt>
                <dd className="truncate text-right text-sm text-strong tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </DialogContent>
    </Dialog>
  );
}
