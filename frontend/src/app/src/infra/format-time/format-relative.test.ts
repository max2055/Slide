import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { formatRelativeTimestamp } from "./format-relative.ts";
import { formatNextRun, formatPresenceAge } from "../../../ui/presenter.ts";
import { renderSessions, type SessionsProps } from "../../../ui/views/sessions.ts";

const NOW = Date.UTC(2026, 10, 13, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("GitHub #703 relative timestamp boundaries", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  for (const direction of [-1, 1]) {
    const label = direction === -1 ? "past" : "future";
    const relative = (value: string) => direction === -1 ? `${value} ago` : `in ${value}`;
    it.each([
      [MINUTE, "1m"],
      [HOUR - 1, "59m"],
      [HOUR, "1h"],
      [DAY - 1, "23h"],
      [DAY, "1d"],
      [47.5 * HOUR, "1d"],
      [2 * DAY - 1, "1d"],
      [2 * DAY, "2d"],
      [7 * DAY, "7d"],
      [8 * DAY, "8d"],
    ])(`${label}: %i ms uses completed units`, (duration, value) => {
      expect(formatRelativeTimestamp(NOW + direction * duration)).toBe(relative(value));
    });

    it.each([1, 59_499, 59_500, MINUTE - 1])(`${label}: %i ms stays below one minute`, (duration) => {
      expect(formatRelativeTimestamp(NOW + direction * duration)).toBe(
        direction === -1 ? "just now" : "in <1m",
      );
    });

    it(`${label}: date fallback uses the raw seven-day boundary and timezone`, () => {
      const options = { dateFallback: true, timezone: "Asia/Shanghai" };
      expect(formatRelativeTimestamp(NOW + direction * 7 * DAY, options)).toBe(relative("7d"));
      for (const duration of [7 * DAY + 1, 8 * DAY]) {
        const timestamp = NOW + direction * duration;
        const date = new Intl.DateTimeFormat("en-US", {
          month: "short", day: "numeric", timeZone: options.timezone,
        }).format(timestamp);
        expect(formatRelativeTimestamp(timestamp, options)).toBe(date);
      }
    });
  }

  it("preserves missing/invalid input and custom fallback", () => {
    for (const input of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(formatRelativeTimestamp(input)).toBe("n/a");
      expect(formatRelativeTimestamp(input, { fallback: "missing" })).toBe("missing");
    }
    expect(formatRelativeTimestamp(NOW)).toBe("just now");
  });

  it("keeps relative direction when the fallback timezone is invalid", () => {
    const options = { dateFallback: true, timezone: "invalid/timezone" };
    expect(formatRelativeTimestamp(NOW - 8 * DAY, options)).toBe("8d ago");
    expect(formatRelativeTimestamp(NOW + 8 * DAY, options)).toBe("in 8d");
  });

  it("reaches the production presenters and rendered session updated cell", () => {
    const timestamp = NOW - 47.5 * HOUR;
    expect(formatPresenceAge({ ts: timestamp })).toBe("1d ago");
    expect(formatNextRun(NOW + 47.5 * HOUR)).toContain("(in 1d)");
    const noop = () => {};
    const props: SessionsProps = {
      loading: false, error: null,
      result: { ts: NOW, path: "test", count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null }, sessions: [
        { key: "max665", kind: "direct", updatedAt: timestamp },
      ] },
      activeMinutes: "", limit: "", includeGlobal: true, includeUnknown: true,
      basePath: "", searchQuery: "", sortColumn: "updated", sortDir: "desc", page: 0, pageSize: 10,
      onFiltersChange: noop, onSearchChange: noop, onSortChange: noop,
      onPageChange: noop, onPageSizeChange: noop, onRefresh: noop,
    };
    const container = document.createElement("div");
    render(renderSessions(props), container);
    expect(container.querySelector("tbody tr")?.textContent).toContain("1d ago");
    expect(container.querySelector("tbody tr")?.textContent).not.toContain("2d ago");
    render(null, container);
  });
});
