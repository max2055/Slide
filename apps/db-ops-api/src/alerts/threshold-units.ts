import type { AlertLevel } from './compiled-rule.js';

/**
 * MAX-232 / issue #256: an alert threshold is only meaningful together with the
 * unit of the metric it is attached to.
 *
 * `linux.filesystem.used_ratio` has `unit=1` and a 0..1 range, so the legacy
 * 80/90/95 percent values must be written as 0.80/0.90/0.95. A rule saved with
 * 80 can never fire on a ratio metric. Byte metrics (`unit=By`) keep absolute
 * integer thresholds and must not receive the filesystem ratio.
 */
export type AlertThresholdLevel = AlertLevel | 'threshold';

export type AlertThresholdCode =
  | 'ALERT_THRESHOLD_RATIO_RANGE'
  | 'ALERT_THRESHOLD_BYTES_ABSOLUTE'
  | 'ALERT_THRESHOLD_MACRO_NOT_ALLOWED';

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
 * Returns the first violation, or null when the thresholds match the metric unit.
 * Metrics in other units (%, count/s, bytes in the legacy registry, ...) are left
 * to the rule editor's existing numeric validation.
 */
export function validateAlertThresholdUnits(input: AlertThresholdInput): AlertThresholdViolation | null {
  const { metricId, unit } = input;
  if (unit !== '1' && unit !== 'By') return null;
  const entries = thresholdEntries(input);

  const macro = entries.find(entry => entry.macro);
  if (macro) {
    const target = unit === '1' ? '0.80/0.90/0.95 等 0–1 比率' : '绝对字节数';
    return {
      code: 'ALERT_THRESHOLD_MACRO_NOT_ALLOWED',
      message: `指标 ${metricId} 的 unit=${unit} 不接受未解析的告警宏 ${macro.macro}；请按单位显式填写${target}。`,
      threshold_level: macro.level,
      value: null,
    };
  }

  if (unit === '1') {
    const bad = entries.find(entry => !(entry.value !== null && entry.value > 0 && entry.value <= 1));
    if (!bad) return null;
    return {
      code: 'ALERT_THRESHOLD_RATIO_RANGE',
      message: `指标 ${metricId} 的 unit=1 是 0–1 比率，${bad.level} 阈值 ${bad.value} 超出范围；80%/90%/95% 应写作 0.80/0.90/0.95，不能直接填 80/90/95。`,
      threshold_level: bad.level,
      value: bad.value,
    };
  }

  const bad = entries.find(entry => !(entry.value !== null && Number.isInteger(entry.value) && entry.value > 0));
  if (!bad) return null;
  return {
    code: 'ALERT_THRESHOLD_BYTES_ABSOLUTE',
    message: `指标 ${metricId} 的 unit=By 需要绝对字节阈值（正整数），${bad.level} 阈值 ${bad.value} 不是绝对字节；文件系统使用率请改用 linux.filesystem.used_ratio 与 0.80/0.90/0.95。`,
    threshold_level: bad.level,
    value: bad.value,
  };
}
