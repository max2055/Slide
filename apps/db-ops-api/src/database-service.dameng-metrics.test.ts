import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';

const connections = (databaseService as any).connections as Map<number, any>;
const instanceId = 993;

function installConnection(unavailable: string[] = []) {
  const counters = { executes: 1000, commits: 100 };
  const execute = vi.fn(async (sql: string) => {
    if (unavailable.some((view) => sql.includes(view))) throw new Error('View unavailable');
    if (sql.includes('V$MEM_POOL')) return { rows: [[1000, 375]] };
    if (sql.includes('V$PARAMETER')) return { rows: [[500]] };
    if (sql.includes('V$SESSIONS')) return { rows: [[sql.includes('ACTIVE') ? 10 : 20]] };
    if (sql.includes('SUM(CASE')) return { rows: [[0, String(counters.executes), String(counters.commits)]] };
    if (sql.includes('V$SYSSTAT')) return { rows: [] };
    if (sql.includes('V$BUFFERPOOL')) return { rows: [[0]] };
    if (sql.includes('V$LOCK') || sql.includes('V$DEADLOCK_HISTORY')) return { rows: [[0]] };
    if (sql.includes('V$INSTANCE')) return { rows: [['DM8']] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  connections.set(instanceId, { id: instanceId, connected: true, db_type: 'dameng', dmConnection: { execute } });
  return counters;
}

afterEach(() => {
  connections.delete(instanceId);
  vi.restoreAllMocks();
});

describe('Dameng realtime metrics', () => {
  it('reads DM8 pool usage and computes rates from array counters across collections', async () => {
    const counters = installConnection();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await expect(databaseService.getRealtimeMetrics(instanceId)).resolves.toMatchObject({
      memory_usage: 37.5, cpu_usage: 2, connections: 20, qps: 0, tps: 0, dm_buffer_hit_rate: 0,
    });
    counters.executes += 120;
    counters.commits += 60;
    now.mockReturnValue(61000);
    await expect(databaseService.getRealtimeMetrics(instanceId)).resolves.toMatchObject({ qps: 2, tps: 1 });
  });

  it.each([
    ['V$MEM_POOL'],
    ['V$MEM_POOL', 'V$BUFFERPOOL', 'V$DEADLOCK_HISTORY', 'V$INSTANCE'],
  ])('keeps other metrics when optional views fail: %j', async (...unavailable) => {
    installConnection(unavailable);
    const metrics = await databaseService.getRealtimeMetrics(instanceId);
    expect(metrics).toMatchObject({ memory_usage: null, cpu_usage: 2, connections: 20, qps: 0, tps: 0 });
    if (unavailable.includes('V$BUFFERPOOL')) expect(metrics).not.toHaveProperty('dm_buffer_hit_rate');
    if (unavailable.includes('V$DEADLOCK_HISTORY')) expect(metrics).not.toHaveProperty('dm_deadlock_count');
  });
});
