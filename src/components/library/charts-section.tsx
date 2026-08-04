import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Book } from "@/core/library";
import type { DailyStats } from "@/core/storage";
import {
  bookPace,
  dailyMinutesSeries,
  estimateDaysLeft,
  movingAverage,
  speedSeries,
  topBookInWindow,
} from "@/core/stats";
import { SettingsBlock, SettingsGroup } from "./settings-group";

// The last-two-weeks charts: minutes per day with a moving average, reading
// speed, and the current book's pace with an ETA. All hand-rolled SVG — the
// dithered fills are plain dot patterns, no chart library. Charts stretch to
// the card width via preserveAspectRatio="none"; strokes opt out of the
// stretch with vector-effect, and the speed dots are round-capped
// zero-length strokes (a filled shape would distort).
const WINDOW = 14;
const SLOT = 22; // viewBox units per day
const BAR = 12; // bar width
const H = 100; // viewBox height
const TOP = 12; // headroom so peaks and dots keep clear of the edge

function ChartHeader({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-content">{label}</span>
      {value ? (
        <span className="text-xs text-muted-content tabular-nums">{value}</span>
      ) : null}
    </div>
  );
}

function MinutesChart({ points }: { points: { key: string; minutes: number }[] }) {
  const { t } = useTranslation();
  // Pattern ids must not collide across instances; useId can contain
  // characters url(#...) dislikes, so strip them.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const max = Math.max(...points.map((p) => p.minutes));
  const w = points.length * SLOT;
  const y = (v: number) => H - (v / max) * (H - TOP);
  const average = movingAverage(
    points.map((p) => p.minutes),
    7,
  );
  return (
    <svg
      viewBox={`0 0 ${w} ${H}`}
      preserveAspectRatio="none"
      className="h-24 w-full"
      role="img"
      aria-label={t("stats.charts.minutesAria")}
    >
      <defs>
        {/* Dither fill: one dot per tile; the max day gets a denser ramp. */}
        <pattern id={`${uid}-a`} width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="var(--color-primary)" opacity="0.45" />
        </pattern>
        <pattern id={`${uid}-b`} width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="var(--color-primary)" opacity="0.9" />
          <circle cx="3" cy="3" r="1" fill="var(--color-primary)" opacity="0.9" />
        </pattern>
      </defs>
      <line
        x1={0}
        y1={H}
        x2={w}
        y2={H}
        stroke="var(--ds-border-subtle)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {points.map((p, i) =>
        p.minutes > 0 ? (
          <rect
            key={p.key}
            x={i * SLOT + (SLOT - BAR) / 2}
            y={y(p.minutes)}
            width={BAR}
            height={H - y(p.minutes)}
            rx={1}
            fill={`url(#${uid}-${p.minutes === max ? "b" : "a"})`}
          />
        ) : null,
      )}
      <polyline
        points={average
          .map((v, i) => `${i * SLOT + SLOT / 2},${y(v)}`)
          .join(" ")}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function SpeedChart({
  series,
  dayKeys,
}: {
  series: { kind: "chars" | "pages"; points: { key: string; perHour: number }[] };
  dayKeys: string[];
}) {
  const { t } = useTranslation();
  const slotOf = new Map(dayKeys.map((key, i) => [key, i]));
  const max = Math.max(...series.points.map((p) => p.perHour));
  const w = dayKeys.length * SLOT;
  const y = (v: number) => TOP + (1 - v / max) * (H - TOP * 2);
  const x = (key: string) => (slotOf.get(key) ?? 0) * SLOT + SLOT / 2;
  return (
    <svg
      viewBox={`0 0 ${w} ${H}`}
      preserveAspectRatio="none"
      className="h-24 w-full"
      role="img"
      aria-label={t("stats.charts.speedAria")}
    >
      {series.points.length > 1 ? (
        <polyline
          points={series.points.map((p) => `${x(p.key)},${y(p.perHour)}`).join(" ")}
          fill="none"
          stroke="var(--ds-content-muted)"
          opacity={0.6}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {series.points.map((p) => (
        <line
          key={p.key}
          x1={x(p.key)}
          y1={y(p.perHour)}
          x2={x(p.key) + 0.01}
          y2={y(p.perHour)}
          stroke="var(--color-primary)"
          strokeWidth={4}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

export function ChartsSection({
  days,
  books,
  todayKey,
}: {
  days: DailyStats[];
  books: Book[];
  todayKey: string;
}) {
  const { t } = useTranslation();
  const minutes = dailyMinutesSeries(days, WINDOW, todayKey);
  const maxMinutes = Math.max(...minutes.map((p) => p.minutes));
  const speed = speedSeries(days, WINDOW, todayKey);
  const topId = topBookInWindow(days, WINDOW, todayKey);
  const book = topId ? books.find((b) => b.id === topId) : undefined;
  const pace = topId && book ? bookPace(days, topId, WINDOW, todayKey) : null;

  // Same emptiness spirit as the heatmap: nothing read, nothing to draw.
  if (maxMinutes <= 0 && !speed && !(book && pace)) return null;

  let eta: number | null = null;
  if (book && pace) {
    const read = pace.chars > 0 ? pace.chars : pace.pages;
    const perActiveDay = pace.activeDays > 0 ? read / pace.activeDays : 0;
    eta = estimateDaysLeft(read, book.progress, perActiveDay);
  }

  return (
    <SettingsGroup title={t("stats.charts.title")}>
      <SettingsBlock>
        <div className="flex flex-col gap-5">
          {maxMinutes > 0 ? (
            <div className="flex flex-col gap-2">
              <ChartHeader label={t("stats.charts.minutes")} />
              <MinutesChart points={minutes} />
            </div>
          ) : null}
          {speed ? (
            <div className="flex flex-col gap-2">
              <ChartHeader
                label={t("stats.charts.speed")}
                value={t(
                  speed.kind === "chars" ? "stats.speedChars" : "stats.speedPages",
                  { count: speed.points[speed.points.length - 1]!.perHour },
                )}
              />
              <SpeedChart series={speed} dayKeys={minutes.map((p) => p.key)} />
            </div>
          ) : null}
          {book && pace ? (
            <div className="flex flex-col gap-2">
              <ChartHeader label={t("stats.charts.pace")} />
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm text-default">{book.title}</span>
                  <span className="shrink-0 text-xs text-muted-content tabular-nums">
                    {t(
                      pace.chars > 0
                        ? "stats.charts.windowChars"
                        : "stats.charts.windowPages",
                      { count: pace.chars > 0 ? pace.chars : pace.pages },
                    )}
                  </span>
                </div>
                <div className="text-xs text-muted-content tabular-nums">
                  {[
                    pace.speed
                      ? t(
                          pace.speed.kind === "chars"
                            ? "stats.speedChars"
                            : "stats.speedPages",
                          { count: pace.speed.perHour },
                        )
                      : null,
                    eta !== null
                      ? t("stats.charts.etaDays", { count: eta })
                      : t("stats.charts.etaUnknown"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsBlock>
    </SettingsGroup>
  );
}
