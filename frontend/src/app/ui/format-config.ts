/**
 * Shared date/number formatting utilities.
 * Uses user preferences from settings for locale, timezone, and date format.
 */
import type { UiSettings } from "./storage.ts";
import { i18n } from "../i18n/index.ts";

let _cachedSettings: Partial<UiSettings> = {};

export function setFormatSettings(settings: Partial<UiSettings>) {
  _cachedSettings = settings;
}

function getLocale(): string {
  return _cachedSettings.locale || i18n.getLocale();
}

function getTimezone(): string | undefined {
  const tz = _cachedSettings.timezone;
  return tz || undefined;
}

function getDateFormat(): "relative" | "absolute" {
  return _cachedSettings.dateFormat || "absolute";
}

/** Format a date for display */
export function formatDate(date: Date | string | number | null | undefined): string {
  if (date == null) return "—";
  const d = typeof date === "object" ? date : new Date(date);
  if (isNaN(d.getTime())) return "—";

  if (getDateFormat() === "relative") {
    return formatRelativeTime(d);
  }

  const locale = getLocale();
  const tz = getTimezone();
  try {
    return d.toLocaleString(locale, { timeZone: tz });
  } catch {
    return d.toLocaleString(locale);
  }
}

/** Format a number for display */
export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  const locale = getLocale();
  try {
    return n.toLocaleString(locale);
  } catch {
    return String(n);
  }
}

/** Format a relative time string */
export function formatRelativeTime(date: Date | string | number): string {
  const d = typeof date === "object" ? date : new Date(date);
  const minutes = Math.trunc((d.getTime() - Date.now()) / 60_000);
  const hours = Math.trunc(minutes / 60);
  const days = Math.trunc(hours / 24);
  const relative = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  if (Math.abs(minutes) < 1) return relative.format(0, "second");
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  if (Math.abs(days) < 7) return relative.format(days, "day");
  try {
    return d.toLocaleDateString(getLocale(), { timeZone: getTimezone() });
  } catch {
    return d.toLocaleDateString(getLocale());
  }
}

/** Format duration in ms */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

/** Format a percentage */
export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}
