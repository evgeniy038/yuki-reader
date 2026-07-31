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

export function formatDateShort(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(lng(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateLong(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(lng(), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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
