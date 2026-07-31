import { useTranslation } from "react-i18next";
import type { DailyStats } from "@/core/storage";
import type { Streaks } from "@/core/stats";
import { formatDuration, formatNumber } from "@/lib/format";
import { SettingsGroup, SettingsRow } from "./settings-group";

function Value({ children }: { children: string }) {
  return <span className="text-sm text-strong tabular-nums">{children}</span>;
}

// The day's headline numbers plus the all-time counters: chars/pages, active
// time, reading speed (from a minute of active time up) and the day streak.
export function SummarySection({
  today,
  streak,
  total,
  todaySpeed,
}: {
  today: DailyStats | undefined;
  streak: Streaks | null;
  total: DailyStats | null;
  todaySpeed: string | null;
}) {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("stats.summary")}>
      <SettingsRow label={t("stats.charsToday")}>
        <Value>{formatNumber(today?.chars ?? 0)}</Value>
      </SettingsRow>
      {today?.pages ? (
        <SettingsRow label={t("stats.pagesToday")}>
          <Value>{formatNumber(today.pages)}</Value>
        </SettingsRow>
      ) : null}
      <SettingsRow label={t("stats.timeToday")}>
        <Value>{formatDuration(today?.timeMs ?? 0)}</Value>
      </SettingsRow>
      {todaySpeed !== null ? (
        <SettingsRow label={t("stats.speedToday")}>
          <Value>{todaySpeed}</Value>
        </SettingsRow>
      ) : null}
      <SettingsRow label={t("stats.streak")}>
        <Value>{t("stats.streakDays", { count: streak?.current ?? 0 })}</Value>
      </SettingsRow>
      <SettingsRow label={t("stats.totalChars")}>
        <Value>{formatNumber(total?.chars ?? 0)}</Value>
      </SettingsRow>
      {total?.pages ? (
        <SettingsRow label={t("stats.totalPages")}>
          <Value>{formatNumber(total.pages)}</Value>
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
}
