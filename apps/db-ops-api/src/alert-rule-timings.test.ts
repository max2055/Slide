import { describe, expect, it, vi, afterEach } from 'vitest';
import { dbConnection } from './db-connection.js';
import { alertDatabaseService as alerts } from './alert-database-service.js';
const base = { name: 'zero', metric_name: 'connections', operator: '>', threshold: 1, severity: 'warning' };
afterEach(() => vi.restoreAllMocks());
describe('alert rule timing persistence #417', () => {
  it('creates with explicit zero, and only defaults omitted timings', async () => {
    const execute = vi.fn(async (_sql: string, _values: any[]) => [{ insertId: 42 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    vi.spyOn(dbConnection, 'isConnected').mockReturnValue(true);
    expect((await alerts.createAlertRule({ ...base, duration_seconds: 0, silence_minutes: 0 })).success).toBe(true);
    expect(execute.mock.calls[0][1].slice(8, 10)).toEqual([0, 0]);
    await alerts.createAlertRule(base);
    expect(execute.mock.calls[1][1].slice(8, 10)).toEqual([5, 60]);
  });
  for (const field of ['duration_seconds', 'silence_minutes']) {
    it.each([null, '', '0', 'abc', NaN, Infinity, -1, 0.5, 2147483648])(`rejects ${field}=%s for create and edit before SQL`, async value => {
      const execute = vi.fn(); vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
      const data = { [field]: value } as any;
      expect((await alerts.createAlertRule({ ...base, ...data })).success).toBe(false);
      expect((await alerts.updateAlertRule(42, data)).success).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });
  }
});
