import type { DerivedMetric } from '../contracts/metrics/index.js';
import { metricKey } from './policy/model.js';

type Timing = { interval_ms: number; stale_after_ms: number; max_counter_gap_ms: number };
function commonInterval(a: number, b: number): number {
  let left = a, right = b;
  while (right) [left, right] = [right, left % right];
  return Math.min(Number.MAX_SAFE_INTEGER, a / left * b);
}

/** Slow items still have time to deliver and compare two normally spaced samples. */
export function metricTiming(settings: Timing, interval?: number): Timing {
  if (interval === undefined) return settings;
  return { interval_ms: interval, stale_after_ms: Math.max(settings.stale_after_ms, interval * 2),
    max_counter_gap_ms: Math.max(settings.max_counter_gap_ms, interval * 2) };
}

export function withDerivedIntervals(configured: ReadonlyMap<string, number> | undefined, formulas: DerivedMetric[],
  defaultInterval: number): Map<string, number> {
  const intervals = new Map(configured);
  if (!intervals.size) return intervals;
  for (let changed = true; changed;) {
    changed = false;
    for (const node of formulas) {
      const key = metricKey(node.output);
      const interval = node.inputs.map(input => intervals.get(metricKey(input)) ?? defaultInterval).reduce(commonInterval);
      if ((intervals.get(key) ?? defaultInterval) === interval) continue;
      intervals.set(key, interval);
      changed = true;
    }
  }
  return intervals;
}
