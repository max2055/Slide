import { describe, expect, it } from 'vitest';
import { compileAlertRule, evaluateCompiledRule } from '../src/alerts/compiled-rule.js';

describe('compiled alert rule', () => {
  it('applies the same three-tier threshold semantics to instance and server targets', () => {
    const raw = { metric_name: 'cpu_usage', operator: '>=', threshold: 0, threshold_template: { warning: 80, error: 90, critical: 95 }, severity: 'warning' as const, duration_seconds: 60 };
    expect(evaluateCompiledRule(compileAlertRule(raw, 'instance'), 91)).toBe('error');
    expect(evaluateCompiledRule(compileAlertRule({ ...raw, target_type: 'server' }, 'server'), 91)).toBe('error');
  });
  it('rejects a rule evaluated against the wrong resource target', () => {
    expect(() => compileAlertRule({ metric_name: 'cpu_usage', operator: '>', threshold: 80, severity: 'warning', target_type: 'server' }, 'instance')).toThrow('ALERT_RULE_TARGET_MISMATCH');
  });
});
