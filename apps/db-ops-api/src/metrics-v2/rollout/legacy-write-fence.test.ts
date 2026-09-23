import { describe, expect, it, vi } from 'vitest';
import { withLegacyMetricWrite } from './legacy-write-fence.js';

function database(rows: Array<Record<string, unknown>>) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('metric_v2_policy_lock')) return [[{ id: 1 }], []];
    if (sql.includes('FROM metric_v2_rollout')) return [rows, []];
    throw new Error(`unexpected query: ${sql}`);
  });
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  return { pool: { getConnection: vi.fn(async () => connection) }, connection, execute };
}

describe('legacy metric write fencing', () => {
  it.each([
    ['unregistered resource', []],
    ['uniform applied legacy resource', [
      { source: 'legacy', read_mode: 'legacy', published_revision: 3, applied_revision: 3 },
      { source: 'legacy', read_mode: 'legacy', published_revision: 3, applied_revision: 3 },
    ]],
  ])('allows %s and commits its write in the locked transaction', async (_case, rows) => {
    const { pool, connection } = database(rows);
    const write = vi.fn(async (c) => {
      expect(c).toBe(connection);
      return 'stored';
    });

    await expect(withLegacyMetricWrite(pool as never, { type: 'instance', id: 7 }, write))
      .resolves.toEqual({ written: true, value: 'stored' });

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['pending v2', [{ source: 'v2', read_mode: 'v2', published_revision: 4, applied_revision: null }]],
    ['applied v2', [{ source: 'v2', read_mode: 'v2', published_revision: 4, applied_revision: 4 }]],
    ['mixed source', [
      { source: 'legacy', read_mode: 'legacy', published_revision: 3, applied_revision: 3 },
      { source: 'v2', read_mode: 'v2', published_revision: 4, applied_revision: 4 },
    ]],
    ['pending rollback', [{ source: 'legacy', read_mode: 'legacy', published_revision: 5, applied_revision: null }]],
  ])('suppresses %s without invoking the writer', async (_case, rows) => {
    const { pool, connection } = database(rows);
    const write = vi.fn();

    await expect(withLegacyMetricWrite(pool as never, { type: 'server', id: 9 }, write))
      .resolves.toEqual({ written: false });

    expect(write).not.toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows a legacy persistence failure', async () => {
    const { pool, connection } = database([]);
    await expect(withLegacyMetricWrite(pool as never, { type: 'network_device', id: 11 }, async () => {
      throw new Error('write failed');
    })).rejects.toThrow('write failed');
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
