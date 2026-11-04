// Locale-aware formatting hub: every user-visible number, date, duration and
// speed label goes through here, so the active UI language drives Intl and
// i18next plurals instead of a hardcoded locale.

import i18n from "@/lib/i18n";
import { speedOf, type BookAmount } from "@/core/stats";

const lng = () => i18n.resolvedLanguage ?? i18n.language ?? "en";

const numberFmts = new Map<string, Intl.NumberFormat>();

function numberFmt(): Intl.NumberFormat {
  const lang = lng();
  let fmt = numberFmts.get(lang);
  if (!fmt) {
    fmt = new Intl.NumberFormat(lang);
    numberFmts.set(lang, fmt);
  }
  return fmt;
}

export function formatNumber(value: number): string {
  return numberFmt().format(value);
}

export function formatDateLong(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(lng(), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** A "YYYY-MM-DD" day key as a local date label; the noon anchor pins the
    day against timezone edges. Options choose the fields shown. */
export function formatDayKey(
  key: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(lng(), options).format(
    new Date(`${key}T12:00:00`),
  );
}

/** Active time as a short label: seconds under a minute, then min / h min. */
export function formatDuration(timeMs: number): string {
  // Sub-minute sessions show seconds — "0 min" for real reading looks broken.
  if (timeMs < 60_000) {
    return i18n.t("time.sec", { count: Math.round(timeMs / 1000) });
  }
  const minutes = Math.round(timeMs / 60_000);
  if (minutes < 60) return i18n.t("time.min", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? i18n.t("time.hMin", { hours, minutes: rest })
    : i18n.t("time.h", { count: hours });
}

/** Reading speed label: chars/h for text volume, pages/h when only pages
    moved; null under a minute of active time (decision in core speedOf). */
export function speedLabel(amount: BookAmount): string | null {
  const speed = speedOf(amount);
  if (speed === null) return null;
  return speed.kind === "chars"
    ? i18n.t("stats.speedChars", { count: speed.perHour })
    : i18n.t("stats.speedPages", { count: speed.perHour });
}

/** "2 minutes ago" / "2 мин назад" — for the sync status line. */
export function formatTimeAgo(timestamp: number, now = Date.now()): string {
  const fmt = new Intl.RelativeTimeFormat(lng(), { numeric: "auto", style: "short" });
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 60) return fmt.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return fmt.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return fmt.format(hours, "hour");
  return fmt.format(Math.round(hours / 24), "day");
}

/** Transfer size: bytes, KB or MB in the active locale's number format. */
export function formatBytes(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(lng(), {
    style: "unit",
    unit: units[unit],
    // narrow: "347B" / "4.2kB" — "short" reads "347 byte" in English.
    unitDisplay: "narrow",
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
}
