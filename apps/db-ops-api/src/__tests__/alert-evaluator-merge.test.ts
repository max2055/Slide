/**
 * Alert evaluator — JSON metrics_data merge tests (D-15)
 *
 * Verifies getMetricValue merges fixed columns + JSON metrics_data column:
 * - Fixed column: fast path (type-safe number)
 * - metrics_data JSON column: custom metrics stored in JSON
 * - String-to-number coercion in JSON path
 * - Backward compatibility: existing fixed-column path still works
 */
import { describe, it, expect } from 'vitest';
import { getMetricValue } from '../alert-evaluator';

describe('getMetricValue - JSON merge (D-15)', () => {
  it('returns fixed column value directly (fast path)', () => {
    const result = getMetricValue('cpu_usage', { cpu_usage: 75, metrics_data: {} });
    expect(result).toBe(75);
  });

  it('returns custom metric from metrics_data JSON column', () => {
    const result = getMetricValue('custom_metric', {
      cpu_usage: 75,
      metrics_data: { custom_metric: 42 },
    });
    expect(result).toBe(42);
  });

  it('returns null when metric not in fixed columns and no metrics_data', () => {
    const result = getMetricValue('custom_metric', { cpu_usage: 75 });
    expect(result).toBeNull();
  });

  it('returns null for nonexistent metric with empty object', () => {
    const result = getMetricValue('nonexistent', {});
    expect(result).toBeNull();
  });

  it('coerces string values from metrics_data to number', () => {
    const result = getMetricValue('custom_metric', {
      metrics_data: { custom_metric: '50' },
    });
    expect(result).toBe(50);
  });

  it('returns null when metrics is null', () => {
    const result = getMetricValue('cpu_usage', null);
    expect(result).toBeNull();
  });

  it('returns fixed column priority over metrics_data', () => {
    const result = getMetricValue('cpu_usage', {
      cpu_usage: 88,
      metrics_data: { cpu_usage: 99 },
    });
    // Fixed column takes priority
    expect(result).toBe(88);
  });

  it('handles string values in fixed column', () => {
    const result = getMetricValue('cpu_usage', { cpu_usage: '75' });
    expect(result).toBe(75);
  });
});
