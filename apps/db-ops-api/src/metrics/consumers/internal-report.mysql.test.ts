import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection } from '../../db-connection.js';
import { actorContextService } from '../../auth/actor-context.js';
import { serverReportService } from '../../server-report-service.js';
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port || port === 3306)('internal report over task-owned MySQL', () => {
  let root: Pool, pool: Pool;
  const database = `max240_report_${process.pid}`;
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    await pool.query("INSERT INTO servers(id,host,label,os_type,credential_type,credential_encrypted,collection_enabled) VALUES(8402,'report.fixture.invalid','MAX240 internal report','linux','password','unused',0)");
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks(); await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  it('reads formal SQL with its scoped internal identity and keeps missing evidence unknown', async () => {
    const reload = vi.spyOn(actorContextService, 'revalidateActor').mockRejectedValue(new Error('INTERNAL_IDENTITY_IS_NOT_A_SESSION'));
    const result = await serverReportService.generateReport([8402]);
    expect(result.server_count).toBe(1);
    expect(result.servers[0]).toMatchObject({ host: 'report.fixture.invalid', health_status: 'unknown' });
    expect(result.servers[0].semantic_metrics).toMatchObject({ resource: { type: 'server', id: 8402 } });
    expect(reload).not.toHaveBeenCalled();
  });
});
