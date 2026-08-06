import { useTranslation } from "react-i18next";
import type { DailyStats, BookAmount } from "@/core/stats";
import { heatLevel, heatmapWeeks } from "@/core/stats";
import { formatDuration } from "@/lib/format";
import i18n from "@/lib/i18n";
import { Tooltip } from "@/components/ui/tooltip";

// GitHub-style activity heatmap: half a year of weeks, columns stretching to
// the card width (flex-1, square cells) — no dead space at the sides.
// Intensity is by ACTIVE MINUTES — the only unit EPUB chars and PDF pages
// share. Days past today in the current week stay blank. Cells carry a rich
// tooltip (date, time, volume, top books) instead of the native title.
// Renders bare — the surrounding Statistics section owns the group chrome
// and the shared tooltip provider.
const HEAT_WEEKS = 26;

// Literal class list — Tailwind must see every heat level in source.
const HEAT_CLASSES = [
  "bg-heat-0",
  "bg-heat-1",
  "bg-heat-2",
  "bg-heat-3",
  "bg-heat-4",
];

function dateLabel(key: string): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
    day: "numeric",
    month: "short",
  }).format(new Date(`${key}T12:00:00`));
}

// The cell's accessible name doubles as the tooltip headline — date first,
// then time and volume, same order as the tooltip card.
function cellLabel(key: string, day: DailyStats | undefined): string {
  const label = dateLabel(key);
  if (!day) return i18n.t("stats.cell.empty", { date: label });
  const parts = [
    formatDuration(day.timeMs),
    day.chars > 0 ? i18n.t("stats.cell.chars", { count: day.chars }) : null,
    day.pages > 0 ? i18n.t("stats.cell.pages", { count: day.pages }) : null,
  ].filter(Boolean);
  return `${label} — ${parts.join(", ")}`;
}

/** Up to three books of the day, heaviest first; unknown ids are dropped. */
function topBooks(
  perBook: Record<string, BookAmount> | undefined,
  bookMeta: Map<string, { title: string; cover?: string }>,
): { id: string; title: string; cover?: string; amount: BookAmount }[] {
  return Object.entries(perBook ?? {})
    .filter(([id]) => bookMeta.has(id))
    .map(([id, amount]) => ({ id, ...bookMeta.get(id)!, amount }))
    .sort(
      (a, b) =>
        b.amount.chars + b.amount.pages - (a.amount.chars + a.amount.pages),
    )
    .slice(0, 3);
}

function CellBody({
  day,
  date,
  bookMeta,
}: {
  day: DailyStats;
  date: string;
  bookMeta: Map<string, { title: string; cover?: string }>;
}) {
  const { t } = useTranslation();
  const books = topBooks(day.perBook, bookMeta);
  return (
    <span className="flex max-w-56 flex-col gap-1">
      <span className="text-strong">{date}</span>
      <span className="text-default tabular-nums">
        {[
          formatDuration(day.timeMs),
          day.chars > 0 ? t("stats.cell.charsShort", { count: day.chars }) : null,
          day.pages > 0 ? t("stats.cell.pages", { count: day.pages }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {books.map((book) => (
        <span key={book.id} className="flex items-center gap-1.5 tabular-nums">
          {book.cover ? (
            <img
              src={book.cover}
              alt=""
              className="w-5 shrink-0 rounded-sm aspect-2/3 object-cover"
            />
          ) : (
            <span className="w-5 shrink-0 rounded-sm aspect-2/3 bg-muted-surface" />
          )}
          <span className="truncate text-default">{book.title}</span>
          <span className="shrink-0 text-default">
            {`— ${
              book.amount.chars > 0
                ? t("stats.cell.charsShort", { count: book.amount.chars })
                : t("stats.cell.pages", { count: book.amount.pages })
            }`}
          </span>
        </span>
      ))}
    </span>
  );
}

export function ActivityHeatmap({
  days,
  todayKey,
  bookMeta,
}: {
  days: DailyStats[];
  todayKey: string;
  bookMeta: Map<string, { title: string; cover?: string }>;
}) {
  const { t } = useTranslation();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const weeks = heatmapWeeks(todayKey, HEAT_WEEKS);

  return (
    <div
      className="flex gap-0.5"
      role="img"
      aria-label={t("stats.activityAria")}
    >
      {weeks.map((week) => (
        <div key={week[0]!.key} className="flex flex-1 flex-col gap-0.5">
          {week.map(({ key, future }) => {
            if (future) return <div key={key} className="aspect-square" />;
            const day = byDate.get(key);
            const date = dateLabel(key);
            return (
              <Tooltip
                key={key}
                trigger={
                  <div
                    className={`aspect-square rounded-heat ${HEAT_CLASSES[heatLevel(day?.timeMs ?? 0)]}`}
                    tabIndex={0}
                    aria-label={cellLabel(key, day)}
                  />
                }
                content={
                  day ? (
                    <CellBody day={day} date={date} bookMeta={bookMeta} />
                  ) : (
                    t("stats.cell.empty", { date })
                  )
                }
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
