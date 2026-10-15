import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => fixture } }));
import { alertDatabaseService } from './alert-database-service.js';

describe('alert level breakdown', () => {
  beforeEach(() => { fixture.query.mockReset(); });
  it('counts all stored levels across pages while retaining access/status scope and exact filtering', async () => {
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY')) return [[{ level: 'p0', total: 2 }, { level: 'error', total: 1 }, { level: 'future', total: 3 }]];
      if (sql.includes('COUNT(*)')) return [[{ total: 2 }]];
      return [[]];
    });
    const result = await alertDatabaseService.getAlerts({ limit: 1, offset: 0, level: 'p0', status: 'acknowledged', allowed_instance_ids: [23], allowed_server_ids: [], allowed_network_device_ids: [], strict: true });
    expect(result.level_counts).toEqual({ p0: 2, error: 1, future: 3 });
    const [sql, params] = fixture.query.mock.calls.find(([sql]) => sql.includes('GROUP BY'))!;
    expect(sql).toContain('a.instance_id IN (?)');
    expect(sql).toContain('a.status = ?');
    expect(params).toEqual([23, 'acknowledged']);
    const [, filterParams] = fixture.query.mock.calls.find(([sql]) => sql.includes('LEFT JOIN database_instances'))!;
    expect(filterParams).toEqual([23, 'acknowledged', 'p0', 1, 0]);
  });
  it('does not report zero counts when the breakdown query fails in strict mode', async () => {
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY')) throw new Error('injected query failure');
      return sql.includes('COUNT(*)') ? [[{ total: 0 }]] : [[]];
    });
    await expect(alertDatabaseService.getAlerts({ limit: 50, strict: true })).rejects.toThrow('ALERTS_QUERY_FAILED');
  });
});
