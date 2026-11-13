/**
 * Centralized relative-time formatting utilities.
 *
 * Consolidates 7+ scattered implementations (formatAge, formatAgeShort, formatAgo,
 * formatRelativeTime, formatElapsedTime) into two functions:
 *
 * - `formatTimeAgo(durationMs)` — format a duration as "5m ago" / "5m" (for known elapsed time)
 * - `formatRelativeTimestamp(epochMs)` — format an epoch timestamp relative to now (handles future)
 */

export type FormatTimeAgoOptions = {
  /** Append "ago" suffix. Default: true. When false, returns bare unit: "5m", "2h" */
  suffix?: boolean;
  /** Return value for invalid/null/negative input. Default: "unknown" */
  fallback?: string;
};

/**
 * Format a duration (in ms) as a human-readable relative time.
 *
 * Input: how many milliseconds ago something happened.
 *
 * With suffix (default):  "just now", "5m ago", "3h ago", "2d ago"
 * Without suffix:         "0s", "5m", "3h", "2d"
 */
export function formatTimeAgo(
  durationMs: number | null | undefined,
  options?: FormatTimeAgoOptions,
): string {
  const suffix = options?.suffix !== false;
  const fallback = options?.fallback ?? "unknown";

  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return fallback;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.round(totalSeconds / 60);

  if (minutes < 1) {
    return suffix ? "just now" : `${totalSeconds}s`;
  }
  if (minutes < 60) {
    return suffix ? `${minutes}m ago` : `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return suffix ? `${hours}h ago` : `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return suffix ? `${days}d ago` : `${days}d`;
}

export type FormatRelativeTimestampOptions = {
  /** If true, fall back to short date (e.g. "Oct 5") for timestamps >7 days. Default: false */
  dateFallback?: boolean;
  /** IANA timezone for date fallback display */
  timezone?: string;
  /** Return value for invalid/null input. Default: "n/a" */
  fallback?: string;
};

/**
 * Format an epoch timestamp relative to now.
 *
 * Handles both past ("5m ago") and future ("in 5m") timestamps.
 * Selects units from the raw time difference, showing completed units only.
 * Optionally falls back to a short date for timestamps more than 7 days away.
 */
export function formatRelativeTimestamp(
  timestampMs: number | null | undefined,
  options?: FormatRelativeTimestampOptions,
): string {
  const fallback = options?.fallback ?? "n/a";
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return fallback;
  }

  const diff = Date.now() - timestampMs;
  const absDiff = Math.abs(diff);
  const isPast = diff >= 0;

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (absDiff < minuteMs) {
    return isPast ? "just now" : "in <1m";
  }

  if (absDiff < hourMs) {
    const min = Math.floor(absDiff / minuteMs);
    return isPast ? `${min}m ago` : `in ${min}m`;
  }

  if (absDiff < dayMs) {
    const hr = Math.floor(absDiff / hourMs);
    return isPast ? `${hr}h ago` : `in ${hr}h`;
  }

  const day = Math.floor(absDiff / dayMs);
  const relativeDays = isPast ? `${day}d ago` : `in ${day}d`;
  if (!options?.dateFallback || absDiff <= 7 * dayMs) {
    return relativeDays;
  }

  // Fall back to short date display for old timestamps
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(options.timezone ? { timeZone: options.timezone } : {}),
    }).format(new Date(timestampMs));
  } catch {
    return relativeDays;
  }
}
