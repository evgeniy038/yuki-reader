import { useTranslation } from "react-i18next";
import type { DailyStats } from "@/core/storage";
import { heatLevel, heatmapWeeks } from "@/core/stats";
import { formatDuration } from "@/lib/format";
import i18n from "@/lib/i18n";
import { SettingsBlock, SettingsGroup } from "./settings-group";

// GitHub-style activity heatmap: half a year of weeks, columns stretching to
// the card width (flex-1, square cells) — no dead space at the sides.
// Intensity is by ACTIVE MINUTES — the only unit EPUB chars and PDF pages
// share. Days past today in the current week stay blank.
const HEAT_WEEKS = 26;

// Literal class list — Tailwind must see every heat level in source.
const HEAT_CLASSES = [
  "bg-heat-0",
  "bg-heat-1",
  "bg-heat-2",
  "bg-heat-3",
  "bg-heat-4",
];

function cellTitle(key: string, day: DailyStats | undefined): string {
  const label = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
    day: "numeric",
    month: "short",
  }).format(new Date(`${key}T12:00:00`));
  if (!day) return i18n.t("stats.cell.empty", { date: label });
  const parts = [
    formatDuration(day.timeMs),
    day.chars > 0 ? i18n.t("stats.cell.chars", { count: day.chars }) : null,
    day.pages > 0 ? i18n.t("stats.cell.pages", { count: day.pages }) : null,
  ].filter(Boolean);
  return `${label} — ${parts.join(", ")}`;
}

export function ActivityHeatmap({
  days,
  todayKey,
}: {
  days: DailyStats[];
  todayKey: string;
}) {
  const { t } = useTranslation();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const weeks = heatmapWeeks(todayKey, HEAT_WEEKS);

  return (
    <SettingsGroup title={t("stats.activity")}>
      <SettingsBlock>
        <div
          className="flex gap-0.5"
          role="img"
          aria-label={t("stats.activityAria")}
        >
          {weeks.map((week) => (
            <div key={week[0]!.key} className="flex flex-1 flex-col gap-0.5">
              {week.map(({ key, future }) =>
                future ? (
                  <div key={key} className="aspect-square" />
                ) : (
                  <div
                    key={key}
                    title={cellTitle(key, byDate.get(key))}
                    className={`aspect-square rounded-heat ${HEAT_CLASSES[heatLevel(byDate.get(key)?.timeMs ?? 0)]}`}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </SettingsBlock>
    </SettingsGroup>
  );
}
