import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { afterAll, describe, expect, it, vi } from 'vitest';

const wiring = vi.hoisted(() => ({ getPool: vi.fn(), getConnection: vi.fn(), getAllInstances: vi.fn() }));
vi.mock('../src/db-connection.js', () => ({ dbConnection: { getPool: wiring.getPool } }));
vi.mock('../src/database-service.js', () => ({ databaseService: { getConnection: wiring.getConnection } }));
vi.mock('../src/instance-database-service.js', () => ({ instanceDatabaseService: { getAllInstances: wiring.getAllInstances } }));
vi.mock('../src/llm-service.js', () => ({ llmService: {} }));
vi.mock('../src/ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {} }));
import { databaseLogService } from '../src/database-log-service.js';
import { loadMigrations, MigrationRunner } from '../src/migrations/runner.js';

// Explicit opt-in. No credential access or shared DB selection during default discovery.
describe.skipIf(!process.env.MYSQL_LOG_UAT_PROFILES)('MAX-395 real MySQL log persistence', () => {
  const name = `max395_${randomUUID().replaceAll('-', '')}`;
  const instance = { id: 395, name, db_type: 'mysql' };
  let admin: mysql.Connection, sink: mysql.Pool, source: mysql.Pool;
  let created = false, directory: string;

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of [
      async () => { if (source) await source.end(); },
      async () => { if (sink) await sink.end(); },
      async () => { if (created) await admin.query(`DROP DATABASE ${name}`); },
      async () => { if (admin) await admin.end(); },
      async () => { if (directory) await rm(directory, { recursive: true }); },
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    vi.useRealTimers(); vi.restoreAllMocks();
    if (failures.length) throw new AggregateError(failures, 'MAX-395 cleanup failed');
    console.log('MAX-395 cleanup: task-owned database dropped; clients closed');
  }, 15000);

  it('upgrades legacy logs, reads native error_log, and recovers bounded microsecond batches after SQL failure', async () => {
    const profiles = JSON.parse(await readFile(process.env.MYSQL_LOG_UAT_PROFILES!, 'utf8'));
    if (!profiles['mysql-test']) throw new Error('mysql-test profile required');
    const config = { ...profiles['mysql-test'], connectTimeout: 5000 };
    admin = await mysql.createConnection(config);
    await admin.query(`CREATE DATABASE ${name}`); created = true;
    sink = mysql.createPool({ ...config, database: name, connectionLimit: 2 });
    source = mysql.createPool({ ...config, database: name, connectionLimit: 1 });
    const migrationId = '155_mysql_log_source_position.sql';
    const migrations = await loadMigrations();
    directory = await mkdtemp(join(tmpdir(), 'max395-migrations-'));
    for (const migration of migrations.filter(migration => migration.id !== migrationId)) {
      await writeFile(join(directory, migration.id), migration.sql);
    }
    // Actual migration runner: empty DB through old version, legacy data, forward upgrade, repeat.
    await new MigrationRunner(sink, directory).run();
    await sink.query(`INSERT INTO database_logs (instance_id, source, message, collected_at)
      VALUES (395, 'mysql_error', 'legacy 1', NOW()), (395, 'mysql_error', 'legacy 2', NOW())`);
    await new MigrationRunner(sink).run();
    await new MigrationRunner(sink).run();
    const [legacy] = await sink.query<mysql.RowDataPacket[]>('SELECT source_position FROM database_logs');
    expect(legacy).toHaveLength(2); expect(legacy.every(row => row.source_position === null)).toBe(true);
    const [ledger] = await sink.query<mysql.RowDataPacket[]>(
      'SELECT status FROM app_schema_migrations WHERE migration_id = ?', [migrationId]);
    expect(ledger).toEqual([expect.objectContaining({ status: 'completed' })]);
    const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    const ddl = schema.match(/CREATE TABLE IF NOT EXISTS `database_logs`[\s\S]*?;/)?.[0];
    if (!ddl) throw new Error('production database_logs schema missing');
    await sink.query(ddl.replace('`database_logs`', '`database_logs_fresh`'));
    for (const table of ['database_logs', 'database_logs_fresh']) {
      const [column] = await sink.query<mysql.RowDataPacket[]>(`SHOW COLUMNS FROM ${table} LIKE 'source_position'`);
      expect(column[0]).toMatchObject({ Type: 'decimal(20,6)', Null: 'YES', Default: null });
      const [index] = await sink.query<mysql.RowDataPacket[]>(`SHOW INDEX FROM ${table} WHERE Key_name = 'uq_database_log_source_position'`);
      expect(index.map(row => row.Column_name)).toEqual(['instance_id', 'source', 'source_position']);
      expect(index.every(row => row.Non_unique === 0)).toBe(true);
    }
    wiring.getPool.mockReturnValue(sink);
    wiring.getConnection.mockReturnValue({ connected: true, pool: source });
    wiring.getAllInstances.mockResolvedValue([instance]);
    const analysis = vi.spyOn(databaseLogService, 'triggerLogAnalysis').mockResolvedValue();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = async () => (await sink.query<mysql.RowDataPacket[]>(
      'SELECT message, source_position FROM database_logs WHERE source_position IS NOT NULL ORDER BY source_position'))[0];

    // Native performance_schema read → production collector → actual destination writes.
    const [native] = await source.query<mysql.RowDataPacket[]>(
      'SELECT CAST(UNIX_TIMESTAMP(LOGGED) AS CHAR) AS position FROM performance_schema.error_log ORDER BY LOGGED LIMIT 200');
    expect(native.length).toBeGreaterThan(0);
    await databaseLogService.collectLogs();
    expect(errors).not.toHaveBeenCalled();
    expect((await logs()).slice(0, native.length).map(row => row.source_position)).toEqual(native.map(row => row.position));
    const nativeCount = (await logs()).length;
    await sink.query('DELETE FROM database_logs WHERE source_position IS NOT NULL');

    // Controlled real SQL fixture uses the native table shape; only FROM is redirected.
    // No writes/config changes to shared performance_schema or global error logging.
    await sink.query(`CREATE TABLE source_events (LOGGED TIMESTAMP(6) PRIMARY KEY,
      ERROR_CODE VARCHAR(20), PRIO VARCHAR(20), DATA TEXT)`);
    const values = Array.from({ length: 451 }, (_, i) => [
      `2026-01-01 00:00:00.${String(i + 1).padStart(6, '0')}`, 'MY-010000', 'Error', `event ${i + 1}`,
    ]);
    await sink.query('INSERT INTO source_events (LOGGED, ERROR_CODE, PRIO, DATA) VALUES ?', [values]);
    const redirected = { query: (sql: string, params?: any[]) => source.query(
      sql.replace('FROM performance_schema.error_log', 'FROM source_events'), params) };
    wiring.getConnection.mockReturnValue({ connected: true, pool: redirected });
    // Real server-side failure after a confirmed prefix; not an injected rejected Promise.
    await sink.query(`CREATE TRIGGER fail_log BEFORE INSERT ON database_logs FOR EACH ROW
      BEGIN IF NEW.message = 'event 101' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX-395 injected write failure'; END IF; END`);
    analysis.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2099-01-01'));
    await databaseLogService.collectLogs();
    expect(await logs()).toHaveLength(100);
    expect(errors).toHaveBeenCalledTimes(1);
    await sink.query('DROP TRIGGER fail_log');
    await databaseLogService.collectLogs(); expect(await logs()).toHaveLength(300);
    vi.setSystemTime(new Date('2000-01-01'));
    await databaseLogService.collectLogs(); expect(await logs()).toHaveLength(451);
    await databaseLogService.collectLogs(); expect(await logs()).toHaveLength(451);
    vi.useRealTimers();
    const collected = await logs();
    expect(collected.map(row => row.message)).toEqual(values.map(row => row[3]));
    expect(new Set(collected.map(row => row.source_position)).size).toBe(451);

    // Force a stale cursor query to exercise actual duplicate-key recovery after restart/retry.
    wiring.getPool.mockReturnValue({ execute: (sql: string, params: any[]) => sql.includes('MAX(source_position)')
      ? Promise.resolve([[{ position: null }]]) : sink.execute(sql, params) });
    analysis.mockClear();
    await databaseLogService.collectLogs();
    expect(await logs()).toHaveLength(451); expect(analysis).not.toHaveBeenCalled();
    console.log(JSON.stringify({ task: 'MAX-395', database: name,
      mysql: (await admin.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version'))[0][0].version,
      nativeErrorLogRows: nativeCount, fixtureEvents: 451, persistedEvents: collected.length,
      migration: 'empty old baseline → legacy rows → forward upgrade → repeated runner; fresh schema parity',
      checks: ['native error_log SQL', 'application clock ahead/behind', '451 rows within one millisecond',
        '100-row confirmed prefix on real SQL failure', 'remaining rows recovered', 'real unique-key deduplication'],
      modelCalls: 0 }));
  }, 90000);
});
