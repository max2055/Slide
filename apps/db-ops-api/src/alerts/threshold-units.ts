import type { AlertLevel } from './compiled-rule.js';

/**
 * MAX-232 / issue #256: an alert threshold is only meaningful together with the
 * meaning of the metric it is attached to.
 *
 * `linux.filesystem.used_ratio` is a 0..1 ratio, so the legacy 80/90/95 percent
 * values must be written as 0.80/0.90/0.95. A rule saved with 80 can never fire
 * on that metric. Byte metrics (`unit=By`) keep absolute integer thresholds and
 * must not receive the filesystem ratio.
 *
 * `unit=1` alone is not enough: `linux.load.one_minute` is an unbounded load
 * average and `network.interface.oper_up` is a 0/1 link state (down=0). The
 * 0..1 check is therefore keyed off the ratio metric itself, so those metrics
 * keep their own ranges, operators and legitimate zero values.
 */
export type AlertThresholdLevel = AlertLevel | 'threshold';

export type AlertThresholdCode = 'ALERT_THRESHOLD_RATIO_RANGE' | 'ALERT_THRESHOLD_BYTES_ABSOLUTE';

/** Metrics whose value is used bytes divided by total bytes (0..1). */
const RATIO_METRIC_IDS = new Set(['linux.filesystem.used_ratio']);

export interface AlertThresholdViolation {
  code: AlertThresholdCode;
  message: string;
  threshold_level: AlertThresholdLevel;
  value: number | null;
}

export interface AlertThresholdInput {
  metricId: string;
  unit?: string | null;
  threshold?: number | string | null;
  /** Stored `alert_rules.threshold_template` rows may still be JSON strings. */
  threshold_template?: Partial<Record<AlertLevel, number | string | null>> | string | null;
}

const LEVELS: AlertLevel[] = ['warning', 'error', 'critical'];
const MACRO = /^\$\{\w+\}$/;

function templateObject(value: AlertThresholdInput['threshold_template']): Partial<Record<AlertLevel, number | string | null>> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

interface ThresholdEntry {
  level: AlertThresholdLevel;
  value: number | null;
  macro: string | null;
}

function thresholdEntries(input: AlertThresholdInput): ThresholdEntry[] {
  const entries: ThresholdEntry[] = [];
  const template = templateObject(input.threshold_template);
  for (const level of LEVELS) {
    const raw = template[level];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw === 'string' && MACRO.test(raw)) entries.push({ level, value: null, macro: raw });
    else if (Number.isFinite(Number(raw))) entries.push({ level, value: Number(raw), macro: null });
  }
  if (entries.length === 0 && input.threshold !== undefined && input.threshold !== null && input.threshold !== '') {
    const value = Number(input.threshold);
    if (Number.isFinite(value)) entries.push({ level: 'threshold', value, macro: null });
  }
  return entries;
}

/**
 * Returns the first violation, or null when the thresholds match the metric.
 * Other dimensionless metrics (`unit=1`), legacy units and counters are left to
 * the rule editor's existing validation. Unresolved macros on byte metrics keep
 * their existing behaviour; only the ratio metric requires an explicit value
 * because a macro could otherwise resolve to the legacy 80/90/95.
 */
export function validateAlertThresholdUnits(input: AlertThresholdInput): AlertThresholdViolation | null {
  const { metricId, unit } = input;
  const entries = thresholdEntries(input);
  if (entries.length === 0) return null;

  if (RATIO_METRIC_IDS.has(metricId)) {
    const bad = entries.find(entry => entry.value === null || entry.value <= 0 || entry.value > 1);
    if (!bad) return null;
    return {
      code: 'ALERT_THRESHOLD_RATIO_RANGE',
      message: `指标 ${metricId} 是 0–1 比率，${bad.level} 阈值 ${bad.macro ?? bad.value} 超出范围；80%/90%/95% 应写作 0.80/0.90/0.95，不能直接填 80/90/95。`,
      threshold_level: bad.level,
      value: bad.value,
    };
  }

  if (unit !== 'By') return null;
  const bad = entries.find(entry => entry.value !== null && !Number.isInteger(entry.value));
  if (!bad) return null;
  return {
    code: 'ALERT_THRESHOLD_BYTES_ABSOLUTE',
    message: `指标 ${metricId} 的 unit=By 需要绝对字节阈值（整数），${bad.level} 阈值 ${bad.value} 不是绝对字节；文件系统使用率请改用 linux.filesystem.used_ratio 与 0.80/0.90/0.95。`,
    threshold_level: bad.level,
    value: bad.value,
  };
}
