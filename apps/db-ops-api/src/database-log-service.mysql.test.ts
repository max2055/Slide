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

const instance = { id: 395, name: 'MAX-395', db_type: 'mysql' };
const service = databaseLogService as any;
const event = (index: number) => ({ source_position: `1780000000.${String(index).padStart(6, '0')}`,
  ERROR_NUMBER: 'MY-010000', ERROR_SEVERITY: 'Error', ERROR_DATA: `event ${index}` });
let source: ReturnType<typeof event>[];
let persisted: Map<string, any[]>;
let failPosition: string | undefined;
let lostReply: boolean;
let stalePosition: boolean;

// #322 / OCR-0153/0154: assertions concern retained source events, not application time.
describe('MySQL durable log collection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    source = [];
    persisted = new Map();
    failPosition = undefined;
    lostReply = false;
    stalePosition = false;
    mocks.getPool.mockReturnValue({ execute: mocks.execute });
    mocks.getConnection.mockReturnValue({ connected: true, pool: { query: mocks.query } });
    mocks.getAllInstances.mockResolvedValue([instance]);
    mocks.query.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('information_schema')) return [[{ cnt: 1 }]];
      expect(sql).toContain('FROM performance_schema.error_log');
      expect(sql).toContain('ORDER BY LOGGED ASC LIMIT 200');
      expect(sql).toContain('CAST(UNIX_TIMESTAMP(LOGGED) AS CHAR)');
      return [source.filter(row => !params.length || row.source_position > params[0]).slice(0, 200)];
    });
    mocks.execute.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('MAX(source_position)')) {
        return [[{ position: stalePosition ? null : [...persisted.keys()].sort().at(-1) ?? null }]];
      }
      if (sql.startsWith('SELECT id')) return [persisted.has(params[2]) ? [{ id: 1 }] : []];
      const position = params[7];
      if (persisted.has(position)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      if (position === failPosition && !lostReply) throw new Error('destination write failed');
      persisted.set(position, params);
      if (position === failPosition && lostReply) throw new Error('write response lost');
      return [{ affectedRows: 1 }];
    });
    vi.spyOn(databaseLogService, 'triggerLogAnalysis').mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(['2000-01-01', '2099-01-01'])('ignores application clock %s for incremental watermarks', async clock => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(clock));
    source = [event(1)];
    await databaseLogService.collectLogs();
    source.push(event(2));
    await databaseLogService.collectLogs();
    expect([...persisted.keys()]).toEqual(source.map(row => row.source_position));
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([event(1).source_position]);
  });
  it('drains 451 events within one millisecond over bounded rounds without loss or repeats', async () => {
    source = Array.from({ length: 451 }, (_, i) => event(i + 1));
    for (const expected of [200, 400, 451, 451]) {
      await databaseLogService.collectLogs();
      expect(persisted.size).toBe(expected);
    }
    expect([...persisted.keys()]).toEqual(source.map(row => row.source_position));
    expect(databaseLogService.triggerLogAnalysis).toHaveBeenCalledTimes(3);
  });
  it('stops at a partial write failure, reports it and resumes from the confirmed prefix', async () => {
    source = [event(1), event(2), event(3)]; failPosition = event(2).source_position;
    await databaseLogService.collectLogs();
    expect([...persisted.keys()]).toEqual([event(1).source_position]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('日志失败'), expect.any(Error));
    expect(databaseLogService.triggerLogAnalysis).toHaveBeenCalledWith([
      expect.objectContaining({ message: 'event 1' }),
    ], instance.id);
    failPosition = undefined;
    await databaseLogService.collectLogs();
    expect(persisted.size).toBe(3);
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([event(1).source_position]);
  });
  it('recovers a committed write with a lost response using the destination watermark', async () => {
    source = [event(1), event(2)]; failPosition = event(1).source_position; lostReply = true;
    await databaseLogService.collectLogs();
    expect(persisted.size).toBe(1);
    expect(databaseLogService.triggerLogAnalysis).not.toHaveBeenCalled();
    failPosition = undefined;
    await databaseLogService.collectLogs();
    expect(persisted.size).toBe(2);
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([event(1).source_position]);
  });
  it('deduplicates stale reads and concurrent collectors without duplicate analysis', async () => {
    source = [event(1), event(2)]; stalePosition = true;
    await databaseLogService.collectLogs();
    await Promise.all([databaseLogService.collectLogs(), databaseLogService.collectLogs()]);
    expect(persisted.size).toBe(2);
    expect(databaseLogService.triggerLogAnalysis).toHaveBeenCalledTimes(1);
  });
  it('propagates source, cursor and destination failures without advancing or analysing', async () => {
    source = [event(1)];
    mocks.query.mockRejectedValueOnce(new Error('source query failed'));
    await expect(service.collectMySQLErrorLogs(instance)).rejects.toThrow('source query failed');
    mocks.execute.mockRejectedValueOnce(new Error('cursor query failed'));
    await expect(service.collectMySQLErrorLogs(instance)).rejects.toThrow('cursor query failed');
    failPosition = event(1).source_position;
    await expect(service.collectMySQLErrorLogs(instance)).rejects.toThrow('destination write failed');
    expect(persisted.size).toBe(0);
    expect(databaseLogService.triggerLogAnalysis).not.toHaveBeenCalled();
    failPosition = undefined;
    await service.collectMySQLErrorLogs(instance);
    expect(persisted.size).toBe(1);
  });
  it('throws when the pool disappears before insert and retries the same event', async () => {
    source = [event(1)];
    mocks.getPool.mockReturnValueOnce({ execute: mocks.execute }).mockReturnValueOnce(null);
    await expect(service.collectMySQLErrorLogs(instance)).rejects.toThrow('系统数据库未连接');
    expect(persisted.size).toBe(0);
    await service.collectMySQLErrorLogs(instance);
    expect(persisted.size).toBe(1);
  });
  it('does not treat an unrelated duplicate error as a confirmed source event', async () => {
    source = [event(1)];
    mocks.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(')) return [[{ position: null }]];
      if (sql.startsWith('SELECT id')) return [[]];
      throw Object.assign(new Error('unrelated duplicate'), { code: 'ER_DUP_ENTRY' });
    });
    await expect(service.collectMySQLErrorLogs(instance)).rejects.toThrow('unrelated duplicate');
    expect(databaseLogService.triggerLogAnalysis).not.toHaveBeenCalled();
  });
  it('leaves unsupported servers and empty rounds without a synthetic application watermark', async () => {
    mocks.query.mockResolvedValueOnce([[{ cnt: 0 }]]);
    await databaseLogService.collectLogs();
    expect(mocks.execute).not.toHaveBeenCalled();
    await databaseLogService.collectLogs();
    expect(persisted.size).toBe(0);
    expect(databaseLogService.triggerLogAnalysis).not.toHaveBeenCalled();
  });
});
