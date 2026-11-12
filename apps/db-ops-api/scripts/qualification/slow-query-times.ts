/** Explicit local acceptance. Credentials are read only when this command runs.
 * SLIDE_TEST_PROFILES=<profiles.json> pnpm --filter slide-api exec tsx scripts/qualification/slow-query-times.ts
 * Creates/drops one unique MySQL schema; target statistics are not reset.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Client } from 'pg';
import oracledb from 'oracledb';
import ejs from 'ejs';
import { databaseService } from '../../src/database-service.js';
import { metricsDatabaseService } from '../../src/metrics-database-service.js';
import { dbConnection } from '../../src/db-connection.js';
import { monitorCollector } from '../../src/monitor-collector.js';

const profileFile = process.env.SLIDE_TEST_PROFILES;
assert(profileFile, 'SLIDE_TEST_PROFILES is required');
const profiles = JSON.parse(await readFile(profileFile, 'utf8'));
const schema = `max396_${randomBytes(6).toString('hex')}`;
const mysqlConfig = profiles['mysql-test'];
const admin = await mysql.createConnection(mysqlConfig);
let pool: mysql.Pool | undefined;
let pg: Client | undefined;
let oracle: oracledb.Connection | undefined;
const connections = (databaseService as any).connections as Map<number, any>;
let operationError: unknown;
let schemaCreated = false;
const results: Record<string, unknown> = { schema, source: 'real database drivers', models: 0 };
try {
  await admin.query(`CREATE DATABASE \`${schema}\``);
  schemaCreated = true;
  pool = mysql.createPool({ ...mysqlConfig, database: schema, connectionLimit: 2 });
  (dbConnection as any).pool = pool;
  const schemaSql = await readFile(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
  for (const table of ['slow_queries', 'database_instances']) {
    const create = schemaSql.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '`[\\s\\S]*?;'));
    assert(create, `missing table ${table}`);
    await pool.query(create[0]);
  }
  const lifecycle = await readFile(new URL('../../sql/migrations/111_instance_removal_lifecycle.sql', import.meta.url), 'utf8');
  await pool.query(lifecycle);
  await pool.query('CREATE TABLE metric_policy_bindings (resource_key VARCHAR(100), payload JSON)');
  // The collector uses real instance enumeration and the live asset switch.
  for (const [id, type] of [[1, 'mysql'], [2, 'postgresql'], [3, 'oracle']] as const) {
    await pool.execute(`INSERT INTO database_instances (id,name,db_type,host,port,username,password_encrypted,status,lifecycle_state) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, `${schema}-${type}`, type, '127.0.0.1', id, 'fixture', '', 'active', 'available']);
  }
  await pool.query(`SELECT SLEEP(1.1) AS ${schema}`);
  await pool.query(`SELECT SLEEP(1.3) AS ${schema}`);
  connections.set(1, { id: 1, connected: true, db_type: 'mysql', pool });

  pg = new Client({ ...profiles['pg-test'],
    ...(process.env.SLIDE_TEST_PG_PORT ? { port: Number(process.env.SLIDE_TEST_PG_PORT), password: process.env.SLIDE_TEST_PG_PASSWORD } : {}),
  });

  await pg.connect();
  assert((await pg.query('SHOW shared_preload_libraries')).rows[0].shared_preload_libraries.includes('pg_stat_statements'), 'PG target must preload pg_stat_statements');
  const extension = await pg.query("SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'");
  if (!extension.rows.length) {
    assert(process.env.SLIDE_TEST_PG_PORT, 'Only create extensions on an explicitly isolated PG target');
    await pg.query('CREATE EXTENSION pg_stat_statements');
  }
  await pg.query(`SELECT pg_sleep(1.1) /* ${schema} */`);
  await pg.query(`SELECT pg_sleep(1.3) /* ${schema} */`);
  connections.set(2, { id: 2, connected: true, db_type: 'postgresql', pgClient: pg });

  const oracleConfig = profiles['oracle-test'];
  oracle = await oracledb.getConnection({ user: oracleConfig.user, password: oracleConfig.password,
    connectString: `${oracleConfig.host}:${oracleConfig.port}/${oracleConfig.service}` });
  oracle.callTimeout = 15000;
  // PIPE GET is an idle wait and is excluded from Oracle elapsed statistics.
  const sql = `WITH n AS (SELECT /*+ materialize */ LEVEL AS n FROM dual CONNECT BY LEVEL <= 5000) SELECT SUM(SQRT(a.n * b.n)) FROM n a CROSS JOIN n b /* ${schema} */`;
  await oracle.execute(sql);
  await oracle.execute(sql);
  connections.set(3, { id: 3, connected: true, db_type: 'oracle', oraclePool: {}, oracleConnection: oracle });

  const mysqlRows = await databaseService.getSlowQueries(1, 1000);
  const pgRows = await databaseService.getSlowQueries(2, 1000);
  const oracleRows = await databaseService.getSlowQueries(3, 1000);
  assert(mysqlRows && pgRows && oracleRows, 'all sources must be available');
  const mq = mysqlRows.find(q => q.sql_text.includes(schema));
  const pq = pgRows.find(q => q.sql_text.includes(schema));
  const oq = oracleRows.find(q => q.sql_text === sql);
  results.discovery = { mysql: { count: mysqlRows.length, matched: Boolean(mq) }, pg: { count: pgRows.length, matched: Boolean(pq) }, oracle: { count: oracleRows.length, matched: Boolean(oq) } };
  assert(mq && pq && oq, 'generated slow executions must be found');
  for (const q of [mq, pq]) {
    assert(q.min_time_ms != null && q.max_time_ms != null);
    assert(q.min_time_ms < q.avg_time_ms && q.avg_time_ms < q.max_time_ms);
    assert(q.avg_time_ms > 1000);
    assert(q.total_time_ms! > q.max_time_ms);
  }
  assert.equal(oq.min_time_ms, null);
  assert.equal(oq.max_time_ms, null);
  assert(oq.avg_time_ms > 1000 && oq.avg_time_ms < 15000);
  assert.equal(oq.execution_count, 2);
  assert(Math.abs(oq.total_time_ms! - oq.avg_time_ms * 2) < 0.01);
  // Public collector -> real MySQL persistence -> public reader -> EJS report.
  process.env.METRICS_COLLECTION_ENABLED = 'true';
  await monitorCollector.collectSlowQueriesNow();
  for (const [id, source] of [[1, mq], [2, pq], [3, oq]] as const) {
    const stored = (await metricsDatabaseService.getSlowQueries(id, 1000)).find(q => q.sql_text === source.sql_text);
    assert(stored, `collector did not persist generated query for ${id}`);
    assert(Math.abs(stored.avg_time_ms - source.avg_time_ms) < 0.02);
    assert.equal(stored.min_time_ms == null, source.min_time_ms == null);
    if (source.min_time_ms != null) assert(Math.abs(stored.min_time_ms! - source.min_time_ms) < 0.02);
    assert(Math.abs(stored.total_time_ms - source.total_time_ms!) < 0.02);
    const html = await ejs.renderFile(new URL('../../src/templates/reports/slow-query.ejs', import.meta.url).pathname,
      { title: '慢查询验收', instanceName: schema, generatedAt: new Date().toISOString(), accentColor: '#06f', slowQueries: [stored] });
    assert(html.includes(stored.avg_time_ms.toFixed(2)));
    results[String(id)] = { averageMs: stored.avg_time_ms, minimumMs: stored.min_time_ms, maximumMs: stored.max_time_ms, totalMs: stored.total_time_ms, executions: stored.execution_count, report: 'passed' };
  }
  const [versions] = await pool.query('SELECT VERSION() AS version');
  results.mysqlVersion = versions;
  results.pgVersion = (await pg.query('SHOW server_version')).rows;
  results.oracleVersion = (await oracle.execute('SELECT banner FROM v$version')).rows;
  results.status = 'passed';
} catch (error) {
  operationError = error;
} finally {
  connections.clear();
  const closed = await Promise.allSettled([pg?.end(), oracle?.close(), pool?.end()]);
  (dbConnection as any).pool = null;
  const dropped = await Promise.allSettled(schemaCreated ? [admin.query(`DROP DATABASE IF EXISTS \`${schema}\``)] : []);
  const adminClosed = await Promise.allSettled([admin.end()]);
  const cleanupErrors = [...closed, ...dropped, ...adminClosed].filter(r => r.status === 'rejected');
  results.cleanup = cleanupErrors.length ? 'failed' : 'own schema dropped; clients closed; target statistics retained';
  console.log(JSON.stringify(results, null, 2));
  if (cleanupErrors.length) throw new AggregateError([operationError, ...cleanupErrors], 'Acceptance/cleanup failures');
}
if (operationError) throw operationError;
