/** #474 acceptance: only a random, disposable schema; never reads application config. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';

assert.ok(process.env.MIGRATION_TEST_MYSQL_HOST, 'explicit test host required');
assert.ok(process.env.MIGRATION_TEST_MYSQL_PORT, 'explicit test port required');
const config = {
  host: process.env.MIGRATION_TEST_MYSQL_HOST,
  port: Number(process.env.MIGRATION_TEST_MYSQL_PORT),
  user: process.env.MIGRATION_TEST_MYSQL_USER || 'root',
  password: process.env.MIGRATION_TEST_MYSQL_PASSWORD || '',
};
const database = `slide_runner_failure_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'slide-runner-failure-'));
const admin = await mysql.createConnection(config);
let pool: mysql.Pool | undefined;
try {
  const [version] = await admin.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
  console.log(JSON.stringify({ version: version[0].version, database, endpoint: `${config.host}:${config.port}` }));
  await admin.query(`CREATE DATABASE \`${database}\``);
  pool = mysql.createPool({ ...config, database, connectionLimit: 1 });
  const id = '999_failure_probe.sql';
  for (const scenario of ['transaction', 'autocommit-off', 'implicit-ddl']) {
    await pool.query('DROP TABLE IF EXISTS app_schema_migrations');
    await pool.query('DROP TABLE IF EXISTS committed_ddl');
    await pool.query('DROP TABLE IF EXISTS probe');
    await pool.query('CREATE TABLE probe (id INT PRIMARY KEY) ENGINE=InnoDB');
    const statements = scenario === 'implicit-ddl'
      ? ['START TRANSACTION', 'INSERT INTO probe VALUES (1)', 'CREATE TABLE committed_ddl (id INT) ENGINE=InnoDB',
        'START TRANSACTION', 'INSERT INTO probe VALUES (2)', 'INSERT INTO probe VALUES (2)', 'COMMIT']
      : [scenario === 'autocommit-off' ? 'SET autocommit = 0' : 'START TRANSACTION',
        'INSERT INTO probe VALUES (1)', 'INSERT INTO probe VALUES (1)', 'COMMIT'];
    await writeFile(join(directory, id), `${statements.join(';\n')};`);
    let failedConnectionId = 0;
    let destroyed = 0;
    let released = 0;
    const migrationPool: MigrationPool = {
      query: (sql, values) => pool!.query(sql, values) as any,
      getConnection: async () => {
        const connection = await pool!.getConnection();
        failedConnectionId = connection.threadId;
        return {
          query: (sql, values) => connection.query(sql, values) as any,
          destroy: () => { destroyed++; connection.destroy(); },
          release: () => { released++; connection.release(); },
        };
      },
    };
    const runner = new MigrationRunner(migrationPool, directory);
    await assert.rejects(runner.run(), /Duplicate entry/);
    assert.equal(destroyed, 1);
    assert.equal(released, 0);
    // Observe through a separate session, not the failed migration connection.
    const [ledger] = await admin.query<mysql.RowDataPacket[]>(
      `SELECT status, statement_index, error FROM \`${database}\`.app_schema_migrations WHERE migration_id = ?`, [id]);
    assert.equal(ledger[0].status, 'failed');
    assert.equal(ledger[0].statement_index, scenario === 'implicit-ddl' ? 5 : 2);
    assert.match(ledger[0].error, /Duplicate entry/);
    const borrowed = await pool.getConnection();
    try {
      assert.notEqual(borrowed.threadId, failedConnectionId);
      const [session] = await borrowed.query<mysql.RowDataPacket[]>('SELECT @@autocommit AS autocommit');
      assert.equal(Number(session[0].autocommit), 1);
      // A later pool user committing cannot accidentally commit failed writes.
      await borrowed.query('COMMIT');
      const [data] = await borrowed.query<mysql.RowDataPacket[]>('SELECT id FROM probe ORDER BY id');
      assert.deepEqual(data.map(row => row.id), scenario === 'implicit-ddl' ? [1] : []);
      const [transactions] = await admin.query<mysql.RowDataPacket[]>(
        'SELECT trx_id FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = ?', [failedConnectionId]);
      assert.equal(transactions.length, 0);
      if (scenario === 'implicit-ddl') {
        await borrowed.query('SELECT * FROM committed_ddl');
      }
    } finally { borrowed.release(); }
    await assert.rejects(runner.run(), /explicit repair/);
    const [afterRetry] = await admin.query<mysql.RowDataPacket[]>(
      `SELECT status, statement_index FROM \`${database}\`.app_schema_migrations WHERE migration_id = ?`, [id]);
    assert.equal(afterRetry[0].status, 'failed');
    assert.equal(afterRetry[0].statement_index, ledger[0].statement_index);
    console.log(`PASS ${scenario}: rollback, externally visible failed ledger/index=${ledger[0].statement_index}, destroyed connection, clean borrow, explicit repair/no replay`);
  }
} finally {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
  console.log(`CLEANUP ${database}: dropped disposable schema and migration directory`);
}
