import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Book } from "@/core/library";
import type { DailyStats } from "@/core/storage";
import {
  bookPace,
  dailyMinutesSeries,
  estimateDaysLeft,
  shiftDay,
  speedOf,
  speedSeries,
  topBookInWindow,
  totals,
} from "@/core/stats";
import { formatDuration } from "@/lib/format";
import i18n from "@/lib/i18n";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { ActivityHeatmap } from "./activity-heatmap";
import { SettingsBlock, SettingsGroup } from "./settings-group";

// The "Statistics" section: minutes per day, reading speed, the current
// book's pace with an ETA, and the half-year activity heatmap at the
// bottom. All hand-rolled SVG — no chart library. Charts stretch to the
// card width via preserveAspectRatio="none"; strokes opt out of the
// stretch with vector-effect, and the speed dots are round-capped
// zero-length strokes (a filled shape would distort). Day letters live in
// HTML under the SVG — text inside a non-uniformly stretched SVG would
// squash. Every chart column is a hover zone with a tooltip — the SVG
// itself carries no pointer logic.
const WINDOW = 14;
const SLOT = 22; // viewBox units per day
const BAR = 14; // bar width
const H = 100; // viewBox height
const TOP = 12; // headroom so peaks and dots keep clear of the edge

/** Slot date in the tooltip headline: "Sat, Aug 2". */
function dayLabel(key: string): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${key}T12:00:00`));
}

// Weekday letters under a chart, one per day column. The SVG slots span the
// full width with no side padding, so equal flex columns line up with them.
function DayAxis({ dayKeys }: { dayKeys: string[] }) {
  const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
    weekday: "narrow",
  });
  return (
    <div className="flex" aria-hidden="true">
      {dayKeys.map((key) => (
        <span
          key={key}
          className="flex-1 text-center text-[10px] leading-none text-muted-content"
        >
          {fmt.format(new Date(`${key}T12:00:00`))}
        </span>
      ))}
    </div>
  );
}

// One invisible hover zone per day slot, laid over the SVG in percents so it
// tracks the stretch. Slots with `null` content stay silent — a hint where
// there is no bar would read like a bug.
function HoverZones({
  dayKeys,
  content,
}: {
  dayKeys: string[];
  content: (key: string) => ReactNode | null;
}) {
  return (
    <>
      {dayKeys.map((key, i) => {
        const body = content(key);
        if (body === null) return null;
        return (
          <Tooltip
            key={key}
            trigger={
              <span
                className="absolute inset-y-0 cursor-default"
                style={{
                  left: `${(i / dayKeys.length) * 100}%`,
                  width: `${100 / dayKeys.length}%`,
                }}
              />
            }
            content={body}
          />
        );
      })}
    </>
  );
}

function TooltipLine({ title, value }: { title: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-muted-content">{title}</span>
      <span className="text-default tabular-nums">{value}</span>
    </span>
  );
}

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
  const max = Math.max(...points.map((p) => p.minutes));
  const w = points.length * SLOT;
  const y = (v: number) => H - (v / max) * (H - TOP);
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${w} ${H}`}
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label={t("stats.charts.minutesAria")}
      >
        {/* Quarter grid + baseline: structure, so a sparse week still reads
            as a chart and not as a bug. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            y1={y(max * f)}
            x2={w}
            y2={y(max * f)}
            stroke="var(--ds-border-subtle)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
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
              rx={2}
              fill="var(--color-primary)"
              opacity={p.minutes === max ? 0.95 : 0.45}
            />
          ) : null,
        )}
      </svg>
      <HoverZones
        dayKeys={points.map((p) => p.key)}
        content={(key) => {
          const point = points.find((p) => p.key === key);
          if (!point || point.minutes <= 0) return null;
          return (
            <TooltipLine
              title={dayLabel(key)}
              value={formatDuration(point.minutes * 60_000)}
            />
          );
        }}
      />
    </div>
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
  // sqrt scale: one binge day must not flatten every other day into the
  // baseline. The tooltip still reports the true number — the axis only
  // decides where points sit.
  const y = (v: number) => TOP + (1 - Math.sqrt(v / max)) * (H - TOP * 2);
  const x = (key: string) => (slotOf.get(key) ?? 0) * SLOT + SLOT / 2;
  const line = series.points.map((p) => `${x(p.key)},${y(p.perHour)}`);
  const area = `M ${line[0]!.split(",")[0]},${H} L ${line.join(" L ")} L ${line[line.length - 1]!.split(",")[0]},${H} Z`;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${w} ${H}`}
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label={t("stats.charts.speedAria")}
      >
        <line
          x1={0}
          y1={H}
          x2={w}
          y2={H}
          stroke="var(--ds-border-subtle)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {series.points.length > 1 ? (
          <>
            <path d={area} fill="var(--color-primary)" opacity={0.08} />
            <polyline
              points={line.join(" ")}
              fill="none"
              stroke="var(--color-primary)"
              opacity={0.85}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
        {series.points.map((p) => (
          <line
            key={p.key}
            x1={x(p.key)}
            y1={y(p.perHour)}
            x2={x(p.key) + 0.01}
            y2={y(p.perHour)}
            stroke="var(--color-primary)"
            strokeWidth={6}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <HoverZones
        dayKeys={dayKeys}
        content={(key) => {
          const point = series.points.find((p) => p.key === key);
          if (!point) return null;
          return (
            <TooltipLine
              title={dayLabel(key)}
              value={t(
                series.kind === "chars" ? "stats.speedChars" : "stats.speedPages",
                { count: point.perHour },
              )}
            />
          );
        }}
      />
    </div>
  );
}

export function ChartsSection({
  days,
  books,
  todayKey,
  bookMeta,
}: {
  days: DailyStats[];
  books: Book[];
  todayKey: string;
  bookMeta: Map<string, { title: string; cover?: string }>;
}) {
  const { t } = useTranslation();
  const minutes = dailyMinutesSeries(days, WINDOW, todayKey);
  const maxMinutes = Math.max(...minutes.map((p) => p.minutes));
  const speed = speedSeries(days, WINDOW, todayKey);
  const topId = topBookInWindow(days, WINDOW, todayKey);
  const book = topId ? books.find((b) => b.id === topId) : undefined;
  const pace = topId && book ? bookPace(days, topId, WINDOW, todayKey) : null;
  // The headline speed is the window aggregate (total volume / total time) —
  // one binge day's number as THE speed would flatter and mislead.
  const windowStart = shiftDay(todayKey, -(WINDOW - 1));
  const avgSpeed = speedOf(
    totals(days.filter((d) => d.date >= windowStart && d.date <= todayKey)),
  );

  // Same emptiness spirit as the heatmap: nothing read, nothing to draw.
  if (maxMinutes <= 0 && !speed && !(book && pace)) return null;

  let eta: number | null = null;
  if (book && pace) {
    const read = pace.chars > 0 ? pace.chars : pace.pages;
    const perActiveDay = pace.activeDays > 0 ? read / pace.activeDays : 0;
    eta = estimateDaysLeft(read, book.progress, perActiveDay);
  }

  return (
    <SettingsGroup title={t("stats.title")}>
      <SettingsBlock>
        {/* One provider for the whole section: sweeping across days, charts
            and heatmap cells switches tooltips instantly. */}
        <TooltipProvider delay={50}>
          <div className="flex flex-col gap-5">
            {maxMinutes > 0 ? (
              <div className="flex flex-col gap-2">
                <ChartHeader label={t("stats.charts.minutes")} />
                <MinutesChart points={minutes} />
                <DayAxis dayKeys={minutes.map((p) => p.key)} />
              </div>
            ) : null}
            {speed ? (
              <div className="flex flex-col gap-2">
                <ChartHeader
                  label={t("stats.charts.speed")}
                  value={
                    avgSpeed
                      ? t(
                          avgSpeed.kind === "chars"
                            ? "stats.speedChars"
                            : "stats.speedPages",
                          { count: avgSpeed.perHour },
                        )
                      : undefined
                  }
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
                    {eta !== null
                      ? t("stats.charts.etaDays", { count: eta })
                      : t("stats.charts.etaUnknown")}
                  </div>
                </div>
              </div>
            ) : null}
            {/* The heatmap closes the section — the long view after the
                two-week detail. */}
            <div className="flex flex-col gap-2">
              <ChartHeader label={t("stats.activity")} />
              <ActivityHeatmap days={days} todayKey={todayKey} bookMeta={bookMeta} />
            </div>
          </div>
        </TooltipProvider>
      </SettingsBlock>
    </SettingsGroup>
  );
}
