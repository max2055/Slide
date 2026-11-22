import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), execute: vi.fn(), getConnection: vi.fn(), getPool: vi.fn(), getAllInstances: vi.fn(),
}));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: mocks.getPool } }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: mocks.getConnection } }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: { getAllInstances: mocks.getAllInstances } }));
vi.mock('./llm-service.js', () => ({ llmService: {} }));
vi.mock('./ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {} }));
import { databaseLogService } from './database-log-service.js';

const instance = { id: 392, name: 'MAX-392', db_type: 'postgresql' };
const service = databaseLogService as any;
const row = (overrides = {}) => ({ datname: 'app', xact_commit: '100', xact_rollback: '10',
  deadlocks: '1', temp_files: '100', temp_bytes: '0', blk_read_time: 100, blk_write_time: 0,
  stats_reset: new Date('2026-01-01T00:00:00Z'), ...overrides });
async function collect(rows: any[]) {
  mocks.query.mockResolvedValueOnce({ rows });
  await databaseLogService.collectLogs();
}
function inserted() {
  return mocks.execute.mock.calls.flatMap(([, values]) => {
    const logs = [];
    for (let i = 0; i < values.length; i += 7) logs.push({ message: values[i + 3], raw: JSON.parse(values[i + 4]) });
    return logs;
  });
}

// GitHub #276 / MAX-392: baseline must not depend on producing an anomaly.
describe('PostgreSQL log collection baseline', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    service.lastCollectTime.clear();
    service.pgLastStats.clear();
    mocks.getPool.mockReturnValue({ execute: mocks.execute });
    mocks.getConnection.mockReturnValue({ connected: true, pgClient: { query: mocks.query } });
    mocks.getAllInstances.mockResolvedValue([instance]);
    mocks.execute.mockResolvedValue([{ affectedRows: 1 }]);
    vi.spyOn(databaseLogService, 'triggerLogAnalysis').mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('establishes the first successful baseline without inserting historical anomalies', async () => {
    await collect([row({ xact_rollback: '500', deadlocks: '80', temp_files: '900', blk_read_time: 9000,
      blk_write_time: 8000 })]);
    expect(service.lastCollectTime.get(instance.id)).toBeInstanceOf(Date);
    expect(service.pgLastStats.has(instance.id)).toBe(true);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('emits all four incremental signals in the second round and none for unchanged counters', async () => {
    await collect([row()]);
    const next = row({ xact_rollback: '35', deadlocks: '3', temp_files: '250', blk_read_time: 2100 });
    await collect([next]);
    expect(inserted().map(log => log.raw.delta)).toEqual([25, 2, 150, 2000]);
    expect(inserted().map(log => log.message)).toEqual([
      expect.stringContaining('事务回滚'), expect.stringContaining('死锁'),
      expect.stringContaining('临时文件'), expect.stringContaining('I/O'),
    ]);
    expect(databaseLogService.triggerLogAnalysis).toHaveBeenCalledTimes(1);
    mocks.execute.mockClear();
    await collect([next]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  // GitHub #1023: each I/O direction qualifies on its own cumulative time and delta.
  it.each([
    { label: 'read only', readTime: 2600, writeTime: 1300, directions: ['read'] },
    { label: 'write only', readTime: 1400, writeTime: 3050, directions: ['write'] },
    { label: 'both directions', readTime: 2600, writeTime: 3050, directions: ['read', 'write'] },
    { label: 'neither direction', readTime: 1200, writeTime: 1300, directions: [] },
  ] as const)('emits I/O latency for $label', async ({ readTime, writeTime, directions }) => {
    await collect([row({ blk_read_time: 1200, blk_write_time: 1300 })]);
    const next = row({ blk_read_time: readTime, blk_write_time: writeTime });
    await collect([next]);

    const expected = {
      read: { message: expect.stringContaining('读 +1400.00 ms'),
        raw: { datname: 'app', direction: 'read', blk_read_time: 2600, delta: 1400 } },
      write: { message: expect.stringContaining('写 +1750.00 ms'),
        raw: { datname: 'app', direction: 'write', blk_write_time: 3050, delta: 1750 } },
    };
    expect(inserted()).toEqual(directions.map(direction => expected[direction]));
    expect(mocks.execute).toHaveBeenCalledTimes(directions.length ? 1 : 0);
    expect(databaseLogService.triggerLogAnalysis).toHaveBeenCalledTimes(directions.length ? 1 : 0);

    await collect([next]);
    expect(mocks.execute).toHaveBeenCalledTimes(directions.length ? 1 : 0);
  });

  it('applies the cumulative and incremental thresholds to each direction independently', async () => {
    await collect([row({ blk_read_time: 100, blk_write_time: 2000 })]);
    await collect([row({ blk_read_time: 1000, blk_write_time: 2500 })]);
    expect(mocks.execute).not.toHaveBeenCalled();
    await collect([row({ blk_read_time: 1500, blk_write_time: 3001 })]);
    expect(inserted().map(log => log.raw)).toEqual([
      { datname: 'app', direction: 'write', blk_write_time: 3001, delta: 501 },
    ]);
  });

  it('advances quiet rounds so below-threshold increments do not accumulate into an anomaly', async () => {
    await collect([row()]);
    await collect([row({ xact_rollback: '20' })]);
    await collect([row({ xact_rollback: '30' })]);
    expect(mocks.execute).not.toHaveBeenCalled();
    await collect([row({ xact_rollback: '41' })]);
    expect(inserted()[0].raw.delta).toBe(11);
  });
  it('keeps both baselines on query failure and compares the next success with the last success', async () => {
    await collect([row()]);
    const time = service.lastCollectTime.get(instance.id), stats = service.pgLastStats.get(instance.id);
    mocks.query.mockRejectedValueOnce(new Error('query failed'));
    await databaseLogService.collectLogs();
    expect(service.lastCollectTime.get(instance.id)).toBe(time);
    expect(service.pgLastStats.get(instance.id)).toBe(stats);
    await collect([row({ xact_rollback: '35' })]);
    expect(inserted()[0].raw.delta).toBe(25);
  });
  it('does not initialize on a failed first query', async () => {
    mocks.query.mockRejectedValueOnce(new Error('query failed'));
    await databaseLogService.collectLogs();
    expect(service.lastCollectTime.has(instance.id)).toBe(false);
    expect(service.pgLastStats.has(instance.id)).toBe(false);
  });
  it('preserves the baseline and suppresses AI on a failed atomic log write', async () => {
    await collect([row()]);
    const time = service.lastCollectTime.get(instance.id), stats = service.pgLastStats.get(instance.id);
    mocks.execute.mockRejectedValueOnce(new Error('write failed'));
    const next = row({ xact_rollback: '35', deadlocks: '3', blk_read_time: 1500, blk_write_time: 2000 });
    await collect([next]);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(inserted().map(log => log.raw.delta)).toEqual([25, 2, 1400, 2000]);
    expect(service.lastCollectTime.get(instance.id)).toBe(time);
    expect(service.pgLastStats.get(instance.id)).toBe(stats);
    expect(databaseLogService.triggerLogAnalysis).not.toHaveBeenCalled();
    mocks.execute.mockClear();
    await collect([next]);
    expect(inserted().map(log => log.raw.delta)).toEqual([25, 2, 1400, 2000]);
    expect(databaseLogService.triggerLogAnalysis).toHaveBeenCalledTimes(1);
    await collect([next]);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(databaseLogService.triggerLogAnalysis).toHaveBeenCalledTimes(1);
  });
  it('preserves the baseline if the destination pool disappears', async () => {
    await collect([row()]);
    const stats = service.pgLastStats.get(instance.id);
    mocks.getPool.mockReturnValueOnce({ execute: mocks.execute }).mockReturnValueOnce(null);
    await collect([row({ xact_rollback: '35' })]);
    expect(service.pgLastStats.get(instance.id)).toBe(stats);
  });
  it.each([
    { stats_reset: new Date('2026-01-02T00:00:00Z') },
    { xact_rollback: '0' }, { deadlocks: '0' }, { temp_files: '0' },
    { blk_read_time: 0 }, { blk_write_time: 0 },
  ])('rebaselines without signals on reset or counter regression: %j', async change => {
    await collect([row({ blk_write_time: 10 })]);
    const reset = row({ xact_rollback: '100', deadlocks: '9', temp_files: '300', blk_read_time: 3000,
      blk_write_time: 2000, ...change });
    await collect([reset]);
    expect(mocks.execute).not.toHaveBeenCalled();
    await collect([{ ...reset, xact_rollback: String(Number(reset.xact_rollback) + 25),
      blk_write_time: reset.blk_write_time + 1500 }]);
    expect(inserted().map(log => log.raw.delta)).toEqual([25, 1500]);
  });
  it('baselines new/reappearing databases independently while retaining existing database signals', async () => {
    await collect([row()]);
    const added = row({ datname: 'new_db', xact_rollback: '999', deadlocks: '40' });
    await collect([row({ xact_rollback: '35' }), added]);
    expect(inserted()).toHaveLength(1);
    expect(inserted()[0].raw.datname).toBe('app');
    mocks.execute.mockClear();
    await collect([row({ xact_rollback: '35' })]);
    await collect([row({ xact_rollback: '35' }), added]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('keeps instances isolated', async () => {
    await collect([row()]);
    mocks.getAllInstances.mockResolvedValue([{ ...instance, id: 393 }]);
    await collect([row({ xact_rollback: '999' })]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
