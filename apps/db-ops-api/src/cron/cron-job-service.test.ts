import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { CronJobDatabaseService } from './cron-job-service.js';

describe('CronJobDatabaseService recovery seed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assigns the typed handler only to the default fault diagnosis job', async () => {
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
    expect(inserts.filter((values) => values[0] !== '故障自动诊断').map((values) => values[3]))
      .toEqual(Array(12).fill(null));
  });
});
