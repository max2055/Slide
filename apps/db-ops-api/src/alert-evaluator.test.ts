import { describe, expect, it } from 'vitest';
import { compileAlertRule, evaluateCompiledRule, type AlertOperator } from './alerts/compiled-rule.js';

const rule = { metric_name: 'cpu_usage', threshold: 50, severity: 'warning' as const };

describe('compiled alert rules', () => {
  const comparisons: Array<[AlertOperator, number, number]> = [
    ['>', 51, 50],
    ['<', 49, 50],
    ['>=', 50, 49],
    ['<=', 50, 51],
    ['=', 50, 51],
    ['!=', 51, 50],
  ];
  it.each(comparisons)('applies %s at the threshold', (operator, firing, clear) => {
    const compiled = compileAlertRule({ ...rule, operator }, 'instance');
    expect(evaluateCompiledRule(compiled, firing)).toBe('warning');
    expect(evaluateCompiledRule(compiled, clear)).toBeNull();
  });

  it('compares a SQL DECIMAL threshold numerically', () => {
    const compiled = compileAlertRule({ ...rule, operator: '>', threshold: '5000.00' as unknown as number }, 'instance');
    expect(evaluateCompiledRule(compiled, 997)).toBeNull();
    expect(evaluateCompiledRule(compiled, 5001)).toBe('warning');
  });

  it('uses available threshold macros and omits unset levels', () => {
    const compiled = compileAlertRule({
      ...rule, operator: '>=',
      threshold_template: { warning: '${warn}', error: '${missing}', critical: '95' },
    }, 'instance', { warn: 80 });
    expect(compiled.thresholds).toEqual({ warning: 80, critical: 95 });
    expect(evaluateCompiledRule(compiled, 90)).toBe('warning');
    expect(evaluateCompiledRule(compiled, 95)).toBe('critical');
  });
});
