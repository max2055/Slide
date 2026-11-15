import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { alertRuleTemplateService as service } from './alert-rule-template-service.js';
import { compileAlertRule } from './alerts/compiled-rule.js';

const valid = { name: '即时模板', metric_name: 'cpu_usage', operator: '>=' };
afterEach(() => vi.restoreAllMocks());

describe('MAX-579 / #486 #487 template write boundary', () => {
  const invalid = [
    { operator: 'invalid' }, { operator: {} }, { target_type: 'database' }, { target_type: '' },
    { severity: 'fatal' }, { severity: null }, { threshold_template: [] },
    { threshold_template: 1 }, { threshold_template: { warning: '10' } },
    { threshold_template: { info: 1 } }, { threshold_template: { warning: Infinity } },
    { threshold_template: { critical: NaN } },
    ...[-1, 0.5, Infinity, NaN, 2147483648, '0', '', false, null, {}].map(duration_seconds => ({ duration_seconds })),
    { silence_minutes: -1 },
  ];
  it.each(invalid)('rejects %j before SQL on both paths', async patch => {
    const pool = vi.spyOn(dbConnection, 'getPool');
    expect((await service.createTemplate({ ...valid, ...patch } as any)).success).toBe(false);
    expect((await service.updateTemplate(1, patch as any)).success).toBe(false);
    expect(pool).not.toHaveBeenCalled();
  });
  it.each([0, 60, 2147483647, undefined])('preserves duration %s and defaults omission', async duration_seconds => {
    const execute = vi.fn().mockResolvedValue([{ insertId: 7, affectedRows: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    expect((await service.createTemplate({ ...valid, duration_seconds })).success).toBe(true);
    expect(execute.mock.calls[0][1][6]).toBe(duration_seconds ?? 60);
    if (duration_seconds !== undefined) {
      await service.updateTemplate(7, { duration_seconds });
      expect(execute.mock.calls[1][1][0]).toBe(duration_seconds);
    }
  });
  it.each(['>', '<', '>=', '<=', '=', '!='])('keeps compiler-compatible operator %s', async operator => {
    const execute = vi.fn().mockResolvedValue([{ insertId: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const threshold_template = { warning: -2, error: 0, critical: 12.5 };
    expect((await service.createTemplate({ ...valid, operator, threshold_template })).success).toBe(true);
    expect(compileAlertRule({ ...valid, operator: operator as any, threshold_template, threshold: 0, severity: 'warning' }, 'instance').thresholds).toEqual(threshold_template);
  });
  it.each([null, {}, { warning: 0 }])('retains historical nullable/partial thresholds %j', async threshold_template => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    expect((await service.updateTemplate(1, { threshold_template })).success).toBe(true);
  });
});
