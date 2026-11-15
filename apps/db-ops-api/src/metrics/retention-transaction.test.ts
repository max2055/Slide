import type { Pool } from 'mysql2/promise';
import { expect, it, vi } from 'vitest';
import { MysqlMetricStorage } from './storage.js';
import { RolloutControl } from './rollout/control.js';
import type { RetentionGuard } from './retention.js';

// MAX-524: both pruning paths must fence only at the commit boundary, and
// failure at that boundary must roll back rather than publish partial work.
it.each(['observations', 'links'] as const)('%s keeps checks separate from the final commit fence', async path => {
  const events: string[] = [];
  const connection = {
    beginTransaction: vi.fn(async () => { events.push('begin'); }),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('metric_policy_lock')) return [[{ id: 1 }]];
      events.push('selection'); return [[]];
    }),
    execute: vi.fn(async () => [[{ id: 1 }]]),
    commit: vi.fn(async () => { events.push('commit'); }),
    rollback: vi.fn(async () => { events.push('rollback'); }),
    release: vi.fn(),
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const prune = (guard: RetentionGuard) => path === 'observations'
    ? new MysqlMetricStorage(pool).prune(1, guard)
    : new RolloutControl(pool).prune(1, 1000, guard);
  const guard: RetentionGuard = async (c, phase) => {
    expect(c).toBe(connection); events.push(phase === 'commit' ? 'fence' : 'check');
  };
  await prune(guard);
  expect(events).toContain('check'); expect(events).toContain('selection');
  expect(events.slice(-2)).toEqual(['fence', 'commit']);
  expect(events.filter(event => event === 'fence')).toHaveLength(1);
  expect(connection.release).toHaveBeenCalledOnce();
  events.length = 0;
  await expect(prune(async (c, phase) => {
    await guard(c, phase);
    if (phase === 'commit') throw new Error('WORKFLOW_LEASE_LOST');
  })).rejects.toThrow('WORKFLOW_LEASE_LOST');
  expect(events.slice(-2)).toEqual(['fence', 'rollback']);
  expect(connection.commit).toHaveBeenCalledOnce();
  expect(connection.release).toHaveBeenCalledTimes(2);
});
