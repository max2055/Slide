/**
 * 测试 alert-evaluator 的宏变量解析功能
 */
import { resolveThresholdTemplate, loadMetricDefaultMacros } from './alert-evaluator';

describe('resolveThresholdTemplate', () => {
  it('resolves numeric thresholds directly', () => {
    const result = resolveThresholdTemplate({ warning: 80, error: 90, critical: 95 });
    expect(result).toEqual({ warning: 80, error: 90, critical: 95 });
  });

  it('resolves string-number thresholds', () => {
    const result = resolveThresholdTemplate({ warning: "80" as any, error: "90" as any, critical: "95" as any });
    expect(result).toEqual({ warning: 80, error: 90, critical: 95 });
  });

  it('resolves ${var} placeholders from macros', () => {
    const result = resolveThresholdTemplate(
      { warning: '${tps_warning}', error: 2000, critical: '${tps_critical}' } as any,
      { tps_warning: 500, tps_critical: 5000 }
    );
    expect(result).toEqual({ warning: 500, error: 2000, critical: 5000 });
  });

  it('returns NaN for unresolvable macros (skipped level)', () => {
    const result = resolveThresholdTemplate(
      { warning: '${unknown_macro}', error: 2000 } as any,
      {}
    );
    expect(result).toEqual({ warning: NaN, error: 2000, critical: NaN });
  });

  it('returns null for null/undefined template', () => {
    expect(resolveThresholdTemplate(null)).toBeNull();
    expect(resolveThresholdTemplate(undefined)).toBeNull();
  });

  it('returns null when all values are NaN', () => {
    const result = resolveThresholdTemplate(
      { warning: '${bad}' as any, error: '${bad2}' as any, critical: '${bad3}' as any },
      {}
    );
    expect(result).toBeNull();
  });

  it('handles mixed numeric and macro values', () => {
    const result = resolveThresholdTemplate(
      { warning: 100, error: '${err_threshold}', critical: '${crit_threshold}' } as any,
      { err_threshold: 500, crit_threshold: 1000 }
    );
    expect(result).toEqual({ warning: 100, error: 500, critical: 1000 });
  });

  it('handles partial template (only warning defined)', () => {
    const result = resolveThresholdTemplate({ warning: '${w}' } as any, { w: 50 });
    expect(result).toEqual({ warning: 50, error: NaN, critical: NaN });
  });

  it('overrides macro values — later macros win on name collision', () => {
    // Simulates: template macros first, then instance overrides overwrite
    const result = resolveThresholdTemplate(
      { warning: '${threshold}', error: '${threshold}', critical: 10000 } as any,
      { threshold: 500 }  // template default
    );
    expect(result).toEqual({ warning: 500, error: 500, critical: 10000 });

    // Instance overrides
    const result2 = resolveThresholdTemplate(
      { warning: '${threshold}', error: '${threshold}', critical: 10000 } as any,
      { threshold: 2000 }  // instance overrides
    );
    expect(result2).toEqual({ warning: 2000, error: 2000, critical: 10000 });
  });

  it('handles null values within template', () => {
    const result = resolveThresholdTemplate({ warning: null, error: 50, critical: null } as any);
    expect(result).toEqual({ warning: NaN, error: 50, critical: NaN });
  });
});

describe('loadMetricDefaultMacros', () => {
  it('extracts macros from metric threshold_template', () => {
    const macros = loadMetricDefaultMacros('tps', { warning: 500, error: 2000, critical: 5000 });
    expect(macros).toEqual({ warning: 500, error: 2000, critical: 5000 });
  });

  it('returns empty for null template', () => {
    const macros = loadMetricDefaultMacros('tps', null);
    expect(macros).toEqual({});
  });

  it('handles partial template', () => {
    const macros = loadMetricDefaultMacros('tps', { warning: 100 });
    expect(macros).toEqual({ warning: 100 });
  });
});
