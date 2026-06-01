/**
 * Shared date/number formatting utilities.
 * Uses user preferences from settings for locale, timezone, and date format.
 */
import type { UiSettings } from "./storage.ts";

let _cachedSettings: Partial<UiSettings> = {};

export function setFormatSettings(settings: Partial<UiSettings>) {
  _cachedSettings = settings;
}

function getLocale(): string {
  return _cachedSettings.locale || "en";
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
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(getLocale());
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
