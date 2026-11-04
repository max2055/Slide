/** #337: explicit endpoint, random disposable schema, no application configuration. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { MigrationRunner, loadMigrations } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';

assert.ok(process.env.MIGRATION_TEST_MYSQL_HOST);
assert.ok(process.env.MIGRATION_TEST_MYSQL_PORT);
const config = {
  host: process.env.MIGRATION_TEST_MYSQL_HOST,
  port: Number(process.env.MIGRATION_TEST_MYSQL_PORT),
  user: process.env.MIGRATION_TEST_MYSQL_USER || 'root',
  password: process.env.MIGRATION_TEST_MYSQL_PASSWORD || '',
};
const database = `slide_baseline_${randomUUID().replaceAll('-', '')}`;
const admin = await mysql.createConnection(config);
let pool: mysql.Pool | undefined;
const lock = 'slide:db-ops:migrations:v1';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
try {
  await admin.query(`CREATE DATABASE \`${database}\``);
  pool = mysql.createPool({ ...config, database, connectionLimit: 4 });
  const [version] = await admin.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
  console.log(JSON.stringify({ database, endpoint: `${config.host}:${config.port}`, version: version[0].version }));
  await new MigrationRunner(pool as any).run();
  await pool.query('TRUNCATE app_schema_migrations');
  const count = async () => {
    const [rows] = await admin.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${database}\`.app_schema_migrations`);
    return Number(rows[0].n);
  };
  let destroyed = 0;
  let released = 0;
  let inserts = 0;
  let sessionId = 0;
  const wrapped = (hook: (sql: string, query: () => Promise<any>) => Promise<any>): MigrationPool => ({
    query: (sql, values) => pool!.query(sql, values) as any,
    getConnection: async () => {
      const c = await pool!.getConnection();
      sessionId = c.threadId;
      return {
        query: (sql, values) => hook(sql, () => c.query(sql, values)),
        destroy: () => { destroyed++; c.destroy(); },
        release: () => { released++; c.release(); },
      };
    },
  });
  const failing = wrapped(async (sql, query) => {
    if (sql.startsWith('INSERT INTO app_schema_migrations') && ++inserts === 2) {
      assert.equal(await count(), 0, 'uncommitted first insert invisible to independent session');
      throw new Error('injected second INSERT failure');
    }
    return query();
  });
  await assert.rejects(new MigrationRunner(failing).baseline('test', 'failure'), /injected/);
  assert.equal(await count(), 0);
  assert.equal(destroyed, 1);
  assert.equal(released, 0);
  const [sessions] = await admin.query<mysql.RowDataPacket[]>('SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ?', [sessionId]);
  assert.equal(sessions.length, 0);
  const [locks] = await admin.query<mysql.RowDataPacket[]>('SELECT IS_FREE_LOCK(?) AS free', [lock]);
  assert.equal(Number(locks[0].free), 1);
  console.log('PASS second INSERT rollback: zero visible rows; failed connection closed; lock freed');

  // Pause baseline after its first real INSERT, then start run on another session.
  const entered = deferred();
  const resume = deferred();
  const waiting = deferred();
  let baselineWrites = 0;
  const baselinePool = wrapped(async (sql, query) => {
    const result = await query();
    if (sql.startsWith('INSERT INTO app_schema_migrations') && ++baselineWrites === 1) {
      entered.resolve();
      await resume.promise;
    }
    return result;
  });
  const runPool = wrapped(async (sql, query) => {
    if (sql.includes('GET_LOCK')) waiting.resolve();
    return query();
  });
  const baseline = new MigrationRunner(baselinePool).baseline('test', 'retry concurrency');
  await entered.promise;
  let runFinished = false;
  const run = new MigrationRunner(runPool).run().then(() => { runFinished = true; });
  await waiting.promise;
  assert.equal(await count(), 0);
  assert.equal(runFinished, false);
  resume.resolve();
  await Promise.all([baseline, run]);
  assert.equal(await count(), (await loadMigrations()).length);
  await assert.rejects(new MigrationRunner(pool as any).baseline('test', 'nonempty'), /not empty/);
  console.log('PASS retry + baseline before run: all rows committed; run serialized; nonempty rejected');

  // Reverse ordering: baseline cannot inspect an empty ledger until run releases.
  await pool.query('TRUNCATE app_schema_migrations');
  const held = deferred();
  const releaseRun = deferred();
  const baselineWaiting = deferred();
  const first = new MigrationRunner(wrapped(async (sql, query) => {
    const result = await query();
    if (sql.includes('GET_LOCK')) { held.resolve(); await releaseRun.promise; }
    return result;
  })).run();
  const firstResult = assert.rejects(first, /explicit baseline/);
  await held.promise;
  const second = new MigrationRunner(wrapped(async (sql, query) => {
    if (sql.includes('GET_LOCK')) baselineWaiting.resolve();
    return query();
  })).baseline('test', 'reverse concurrency');
  await baselineWaiting.promise;
  assert.equal(await count(), 0);
  releaseRun.resolve();
  await Promise.all([firstResult, second]);
  assert.equal(await count(), (await loadMigrations()).length);
  console.log('PASS run before baseline: run rejects untracked schema; baseline waits then commits all');
  await assert.rejects(new MigrationRunner(pool as any).baseline('', 'reason'), /actor and reason/);
  await pool.query('TRUNCATE app_schema_migrations');
  await pool.query('RENAME TABLE users TO baseline_hidden_users');
  await assert.rejects(new MigrationRunner(pool as any).baseline('test', 'missing table'), /required tables/);
  assert.equal(await count(), 0);
  await pool.query('RENAME TABLE baseline_hidden_users TO users');
  await pool.query("UPDATE system_config SET config_value = 'invalid' WHERE config_key = 'agent_sandbox_enabled'");
  await assert.rejects(new MigrationRunner(pool as any).baseline('test', 'invalid schema'), /Schema invariant/);
  assert.equal(await count(), 0);
  const [free] = await admin.query<mysql.RowDataPacket[]>('SELECT IS_FREE_LOCK(?) AS free', [lock]);
  assert.equal(Number(free[0].free), 1);
  console.log('PASS blank actor, missing table, invalid invariant rejected; zero rows; lock freed');
} finally {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
  console.log(`CLEANUP dropped ${database}`);
}
