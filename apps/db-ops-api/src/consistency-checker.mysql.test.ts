import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let connection: Connection;
vi.mock('./db-connection', () => ({
  dbConnection: { getPool: () => connection, isConnected: () => true },
}));
import { ConsistencyChecker } from './consistency-checker.js';

// Opt-in disposable localhost MySQL, following the metrics integration suite.
// Never load .env or connect to the application database.
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port)('resource health truth with legacy mixed collations', () => {
  const database = `max210_${process.pid}`;
  const checker = new ConsistencyChecker();
  beforeAll(async () => {
    connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', charset: 'utf8mb4', timezone: 'Z' });
    await connection.query(`CREATE DATABASE ${database}`);
    await connection.query(`USE ${database}`);
    await connection.query("CREATE TABLE database_instances (id INT PRIMARY KEY, health_status VARCHAR(32), status VARCHAR(32))");
    await connection.query("CREATE TABLE servers (id INT PRIMARY KEY, status VARCHAR(32), collection_enabled BOOLEAN)");
    await connection.query("CREATE TABLE metric_rollout (series_hash VARCHAR(64), resource_type VARCHAR(32), resource_id VARCHAR(255), source VARCHAR(32), read_mode VARCHAR(32), generation INT, applied_revision INT, published_revision INT) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    await connection.query("CREATE TABLE metric_publications (series_hash VARCHAR(64), generation INT, observed_at DATETIME, observation_id VARCHAR(64)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    await connection.query("CREATE TABLE metric_observations (id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin, payload JSON)");
    await connection.query("CREATE TABLE metric_policy_bindings (resource_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin, payload JSON)");
    await connection.query("CREATE TABLE cron_job_logs (status VARCHAR(32), started_at DATETIME)");
  });
  afterAll(async () => {
    if (connection) { await connection.query(`DROP DATABASE IF EXISTS ${database}`); await connection.end(); }
  });
  beforeEach(async () => {
    for (const table of ['database_instances', 'servers', 'metric_rollout', 'metric_publications', 'metric_observations', 'metric_policy_bindings', 'cron_job_logs']) {
      await connection.query(`DELETE FROM ${table}`);
    }
  });

  async function seed(type: 'instance' | 'server', resourceId = '1', options: {
    bound?: boolean; published?: boolean; age?: number; applied?: number; observedRevision?: number; bindingRevision?: number;
  } = {}) {
    if (type === 'instance') await connection.execute("INSERT INTO database_instances VALUES (1,'healthy','active')");
    else await connection.execute("INSERT INTO servers VALUES (1,'online',1)");
    await connection.execute("INSERT INTO metric_rollout VALUES ('series',?,?,'semantic','semantic',1,?,1)", [type, resourceId, options.applied ?? 1]);
    if (options.bound !== false) await connection.execute('INSERT INTO metric_policy_bindings VALUES (?,?)', [`${type}:${resourceId}`, JSON.stringify({ binding: { revision: options.bindingRevision ?? 1 } })]);
    if (options.published !== false) {
      await connection.execute("INSERT INTO metric_publications VALUES ('series',1,?,'observation')", [new Date(Date.now() - (options.age ?? 0))]);
      await connection.execute("INSERT INTO metric_observations VALUES ('observation',?)", [JSON.stringify({ versions: { config_revision: options.observedRevision ?? 1 } })]);
    }
  }

  for (const type of ['instance', 'server'] as const) {
    it(`${type}: accepts a fresh formal value across unicode_ci columns and general_ci connection`, async () => {
      await seed(type);
      const result = await checker.resourceHealthTruth();
      expect(result.managedAvailability).toMatchObject({ status: 'healthy', numerator: 1, denominator: 1 });
      expect(result.dataFreshness).toMatchObject({ status: 'healthy', numerator: 1, denominator: 1 });
    });
    for (const [label, options] of [
      ['unbound', { bound: false }], ['no formal value', { published: false }],
      ['stale', { age: 11 * 60_000 }], ['unapplied revision', { applied: 2 }],
      ['old observation revision', { observedRevision: 2 }], ['old binding revision', { bindingRevision: 2 }],
    ] as const) {
      it(`${type}: keeps ${label} visibly unhealthy`, async () => {
        await seed(type, '1', options);
        const result = await checker.resourceHealthTruth();
        expect(result.dataFreshness).toMatchObject({ status: 'critical', numerator: 0, denominator: 1, failedRefs: [{ type, id: 1 }], reason: 'required_metric_stale_or_missing' });
        expect(result.overall).toBe('critical');
      });
    }
    for (const alias of ['01', '1 ', '1e0', '+1', '1x', '1.0']) {
      it(`${type}: does not count non-exact resource ID ${JSON.stringify(alias)}`, async () => {
        await seed(type, alias);
        expect((await checker.resourceHealthTruth()).dataFreshness).toMatchObject({ numerator: 0, denominator: 1 });
      });
    }
    it(`${type}: does not merge a fresh padded alias into the stale canonical ID`, async () => {
      await seed(type, '1', { age: 11 * 60_000 });
      await connection.execute("INSERT INTO metric_rollout VALUES ('alias',?,'1 ','semantic','semantic',1,1,1)", [type]);
      await connection.execute("INSERT INTO metric_publications VALUES ('alias',1,?,'observation')", [new Date()]);
      expect((await checker.resourceHealthTruth()).dataFreshness).toMatchObject({ numerator: 0, denominator: 1 });
    });
  }
  it('keeps workflow observation failure explicitly unknown', async () => {
    await seed('instance');
    await connection.query('DROP TABLE cron_job_logs');
    expect((await checker.resourceHealthTruth()).workflow).toMatchObject({ status: 'unknown', reason: 'workflow_state_unavailable' });
  });
});
