import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { CronJobDatabaseService } from './cron-job-service.js';

describe('CronJobDatabaseService recovery seed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds the recovery log collection seed to a disabled system handler', async () => {
    const execute = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql === 'SELECT COUNT(*) as cnt FROM cron_jobs') return [[{ cnt: 0 }]];
      return [{ affectedRows: 1 }];
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await new CronJobDatabaseService().ensureSeedData();

    const inserts = execute.mock.calls
      .filter(([sql]) => sql.startsWith('INSERT INTO cron_jobs'))
      .map(([, values]) => values ?? []);
    expect(inserts).toHaveLength(13);
    expect(inserts.find((values) => values[0] === '故障自动诊断')?.[3]).toBe('fault.diagnose-unhealthy');
    const logs = inserts.find((values) => values[0] === '数据库日志采集');
    expect(logs?.[3]).toBe('database.logs.collect');
    expect(logs?.slice(7, 10)).toEqual([false, 'system-maintenance', 'bound']);
    expect(inserts.filter((values) => !['故障自动诊断', '数据库日志采集'].includes(String(values[0]))).map((values) => values[3]))
      .toEqual(Array(11).fill(null));
  });
});
