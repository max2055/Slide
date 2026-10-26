import { describe, expect, it } from 'vitest';
import { validateAlertThresholdUnits } from './threshold-units.js';

const GIB = 1_024 ** 3;

describe('alert threshold units (MAX-232 / issue #256)', () => {
  it('accepts the 0–1 ratio values on a unit=1 metric', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: 0.79, error: 0.9, critical: 0.95 },
    })).toBeNull();
  });

  it('rejects the legacy 80/90/95 copy on a ratio metric', () => {
    const violation = validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: 80, error: 90, critical: 95 },
    });
    expect(violation).toMatchObject({
      code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning', value: 80,
    });
    expect(violation?.message).toContain('0.80/0.90/0.95');
  });

  it('rejects a ratio outside 0–1 even when it uses decimals', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold_template: { warning: 1.5 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning' });
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold_template: { warning: 0 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning' });
  });

  it('checks the single static threshold when no template is supplied', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold: 80,
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'threshold', value: 80 });
  });

  it('keeps byte metrics on absolute integer thresholds', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 100 * GIB, error: 500 * GIB, critical: 1_000 * GIB },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 0.8, error: 0.9 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_BYTES_ABSOLUTE', threshold_level: 'warning', value: 0.8 });
    expect(validateAlertThresholdUnits({
      metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 100.5 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_BYTES_ABSOLUTE' });
  });

  it('refuses unresolved legacy macros on ratio and byte metrics', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: '${disk_warning}' },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_MACRO_NOT_ALLOWED', threshold_level: 'warning' });
    expect(validateAlertThresholdUnits({
      metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { critical: '${disk_critical}' },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_MACRO_NOT_ALLOWED', threshold_level: 'critical' });
  });

  it('reads templates persisted as JSON strings and leaves other units alone', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: JSON.stringify({ warning: 80, error: 90, critical: 95 }),
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning' });

    // Legacy percent/state/bytes units and counters keep their own semantics.
    expect(validateAlertThresholdUnits({
      metricId: 'device_cpu_percent', unit: '%', threshold_template: { warning: 80, error: 90, critical: 95 },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'filesystem_size_bytes', unit: 'bytes', threshold_template: { warning: 80 },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: null, threshold_template: { warning: 80 },
    })).toBeNull();
  });
});
