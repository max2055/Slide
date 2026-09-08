import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ connection: {} as any }));
const recordMetrics = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: () => state.connection } }));
vi.mock('./metrics-database-service.js', () => ({ metricsDatabaseService: { recordMetrics } }));

import { unifiedCollector } from './collector.js';
import { collectorRegistry } from './collectors/registry.js';
import type { DatabaseInstance } from './instance-database-service.js';

afterEach(() => vi.restoreAllMocks());

describe('DM8 scheduled collection', () => {
  it('persists other metrics through repeated memory failures and recovers memory next round', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    let memoryAvailable = false;
    let executes = 1000;
    let commits = 100;
    state.connection = {
      dmConnection: {
        execute: vi.fn(async (sql: string) => {
          if (sql.includes('V$MEM_POOL')) {
            if (!memoryAvailable) throw new Error('View unavailable');
            return { rows: [[1000, 375]] };
          }
          if (sql.includes('V$PARAMETER')) return { rows: [[500]] };
          if (sql.includes('V$SESSIONS')) return { rows: [[10]] };
          if (sql.includes('sql executed count')) return { rows: [[executes]] };
          if (sql.includes('transaction commit count')) return { rows: [[commits]] };
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
      },
    };
    const instance = { id: 994, db_type: 'dameng' } as DatabaseInstance;
    const metrics = ['memory_usage', 'cpu_usage', 'connections', 'qps', 'tps'];
    for (let round = 0; round < 4; round++) {
      const result = await unifiedCollector.collectInstance(instance, metrics);
      expect(result).toEqual({ memory_usage: false, cpu_usage: true, connections: true, qps: true, tps: true });
      const payload = recordMetrics.mock.lastCall![0];
      expect(payload).toMatchObject({ instance_id: 994, cpu_usage: 2, connections: 10 });
      expect(payload).not.toHaveProperty('memory_usage');
    }
    expect(collectorRegistry.isEnabled('Dameng Provider', 'instance:994')).toBe(true);

    memoryAvailable = true;
    executes += 120;
    commits += 60;
    now.mockReturnValue(61000);
    expect(await unifiedCollector.collectInstance(instance, metrics)).toMatchObject({ memory_usage: true });
    expect(recordMetrics.mock.lastCall![0]).toMatchObject({ memory_usage: 37.5, qps: 2, tps: 1 });
  });
});
