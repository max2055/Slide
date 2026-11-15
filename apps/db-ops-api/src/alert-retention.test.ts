
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ execute: vi.fn(), getPool: vi.fn() }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: fixture.getPool } }));
import { alertDatabaseService } from './alert-database-service.js';

describe('MAX-563 / #311 retention data protection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.getPool.mockReturnValue(fixture);
    fixture.execute.mockResolvedValue([{ affectedRows: 2 }]);
  });
  it.each([-1, -0.5, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', null])(
    'rejects %s before pool access, counting or deletion', async value => {
      expect((await alertDatabaseService.clearAllAlerts(value as number)).success).toBe(false);
      expect(fixture.getPool).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
    });
  it.each([undefined, 10])('retains the default or specified positive window (%s)', async days => {
    await alertDatabaseService.clearAllAlerts(days);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const [sql, [cutoff]] = fixture.execute.mock.calls[0];
    expect(sql).toContain('created_at < ?');
    expect(sql).toContain('template-trigger');
    expect(Math.abs(cutoff.getTime() - (Date.now() - (days ?? 30) * 86400000))).toBeLessThan(1000);
  });
  it('only explicit zero selects all eligible rows and preserves template-trigger exclusion', async () => {
    fixture.execute.mockResolvedValueOnce([[{ count: 3 }]]).mockResolvedValueOnce([{ affectedRows: 3 }]);
    expect(await alertDatabaseService.clearAllAlerts(0)).toEqual({ success: true, deletedCount: 3 });
    expect(fixture.execute.mock.calls[0][0]).toContain('SELECT COUNT(*)');
    expect(fixture.execute.mock.calls[1][0]).toContain('DELETE FROM alerts WHERE NOT');
  });
});
