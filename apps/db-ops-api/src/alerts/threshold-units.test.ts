import { describe, expect, it } from 'vitest';
import { validateAlertThresholdUnits } from './threshold-units.js';

const GIB = 1_024 ** 3;

describe('filesystem ratio thresholds (MAX-232 / issue #256)', () => {
  it('accepts the 0–1 ratio values on linux.filesystem.used_ratio', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: 0.79, error: 0.9, critical: 0.95 },
    })).toBeNull();
  });

  it('rejects the legacy 80/90/95 copy on the ratio metric', () => {
    const violation = validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: 80, error: 90, critical: 95 },
    });
    expect(violation).toMatchObject({
      code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning', value: 80,
    });
    expect(violation?.message).toContain('0.80/0.90/0.95');
  });

  it('rejects a ratio outside 0–1 and an unresolved macro on the ratio metric', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold_template: { warning: 1.5 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning' });
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold_template: { warning: 0 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning' });
    // A macro could resolve to the legacy 80/90/95, so the ratio metric needs an explicit value.
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold_template: { warning: '${disk_warning}' },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning', value: null });
  });

  it('checks the single static threshold when no template is supplied', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold: 80,
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'threshold', value: 80 });
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1', threshold: 0.8,
    })).toBeNull();
  });

  it('reads templates persisted as JSON strings', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: JSON.stringify({ warning: 80, error: 90, critical: 95 }),
    })).toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', threshold_level: 'warning' });
  });
});

describe('other dimensionless metrics keep their own ranges (MAX-232 review)', () => {
  it('accepts a load average above 1', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'linux.load.one_minute', unit: '1', threshold: 4,
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'linux.load.one_minute', unit: '1', threshold_template: { warning: 4, error: 8, critical: 16 },
    })).toBeNull();
  });

  it('accepts the down state 0 and ordinary macros on a network interface', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'network.interface.oper_up', unit: '1', threshold: 0,
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'network.interface.oper_up', unit: '1', threshold_template: { critical: 0 },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'linux.load.one_minute', unit: '1', threshold_template: { warning: '${load_warning}' },
    })).toBeNull();
  });

  it('leaves other units to their own validation', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'device_cpu_percent', unit: '%', threshold_template: { warning: 80, error: 90, critical: 95 },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'filesystem_size_bytes', unit: 'bytes', threshold_template: { warning: 80 },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'linux.filesystem.used_ratio', unit: null, threshold_template: { warning: 0.8 },
    })).toBeNull();
  });
});

describe('byte metrics stay absolute (MAX-232)', () => {
  it('accepts integer byte thresholds, including zero', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 100 * GIB, error: 500 * GIB, critical: 1_000 * GIB },
    })).toBeNull();
    expect(validateAlertThresholdUnits({
      metricId: 'host.network.bytes_total', unit: 'By', threshold: 0,
    })).toBeNull();
  });

  it('rejects the filesystem ratio copied onto a byte metric', () => {
    expect(validateAlertThresholdUnits({
      metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 0.8, error: 0.9 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_BYTES_ABSOLUTE', threshold_level: 'warning', value: 0.8 });
    expect(validateAlertThresholdUnits({
      metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 100.5 },
    })).toMatchObject({ code: 'ALERT_THRESHOLD_BYTES_ABSOLUTE' });
  });
});
