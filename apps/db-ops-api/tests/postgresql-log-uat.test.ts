import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Client } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';

const wiring = vi.hoisted(() => ({ getPool: vi.fn(), getConnection: vi.fn(), getAllInstances: vi.fn() }));
vi.mock('../src/db-connection.js', () => ({ dbConnection: { getPool: wiring.getPool } }));
vi.mock('../src/database-service.js', () => ({ databaseService: { getConnection: wiring.getConnection } }));
vi.mock('../src/instance-database-service.js', () => ({ instanceDatabaseService: { getAllInstances: wiring.getAllInstances } }));
vi.mock('../src/llm-service.js', () => ({ llmService: {} }));
vi.mock('../src/ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {} }));
import { databaseLogService } from '../src/database-log-service.js';

// Explicit opt-in; normal test discovery never reads local credentials or uses shared databases.
describe.skipIf(!process.env.PG_LOG_UAT_PROFILES)('MAX-392 real PostgreSQL → MySQL log persistence', () => {
  const name = `max392_${randomUUID().replaceAll('-', '')}`;
  const instance = { id: 392, name, db_type: 'postgresql' };
  const service = databaseLogService as any;
  let admin: Client, collector: Client, worker: Client;
  let mysqlAdmin: mysql.Connection, sink: mysql.Pool;
  let pgCreated = false, mysqlCreated = false;

  afterAll(async () => {
    // Stop clients before dropping only this task's databases. Preserve cleanup failures.
    const failures: unknown[] = [];
    for (const cleanup of [
      async () => { if (worker) await worker.end(); },
      async () => { if (collector) await collector.end(); },
      async () => { if (sink) await sink.end(); },
      async () => { if (pgCreated) await admin.query(`DROP DATABASE ${name}`); },
      async () => { if (mysqlCreated) await mysqlAdmin.query(`DROP DATABASE ${name}`); },
      async () => { if (admin) await admin.end(); },
      async () => { if (mysqlAdmin) await mysqlAdmin.end(); },
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    service.lastCollectTime.clear();
    service.pgLastStats.clear();
    vi.restoreAllMocks();
    if (failures.length) throw new AggregateError(failures, 'UAT cleanup failed');
    console.log('MAX-392 cleanup: task-owned PostgreSQL/MySQL databases dropped; clients closed');
  }, 15000);

  it('baselines quiet statistics, preserves the baseline on a real SQL write failure, then persists a real rollback signal', async () => {
    const profiles = JSON.parse(await readFile(process.env.PG_LOG_UAT_PROFILES!, 'utf8'));
    const pgConfig = { ...profiles['pg-test'], connectionTimeoutMillis: 5000, statement_timeout: 5000 };
    const mysqlConfig = { ...profiles['mysql-test'], connectTimeout: 5000 };
    admin = new Client(pgConfig);
    await admin.connect();
    const version = (await admin.query('SHOW server_version')).rows[0].server_version;
    await admin.query(`CREATE DATABASE ${name}`);
    pgCreated = true;
    mysqlAdmin = await mysql.createConnection(mysqlConfig);
    await mysqlAdmin.query(`CREATE DATABASE ${name}`);
    mysqlCreated = true;
    sink = mysql.createPool({ ...mysqlConfig, database: name, connectionLimit: 2 });
    const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    const logTable = schema.match(/CREATE TABLE IF NOT EXISTS `database_logs`[\s\S]*?;/)?.[0];
    if (!logTable) throw new Error('database_logs production schema missing');
    await sink.query(logTable);
    collector = new Client({ ...pgConfig, database: name });
    await collector.connect();
    wiring.getPool.mockReturnValue(sink);
    wiring.getConnection.mockReturnValue({ connected: true, pgClient: collector });
    wiring.getAllInstances.mockResolvedValue([instance]);
    const analysis = vi.spyOn(databaseLogService, 'triggerLogAnalysis').mockResolvedValue();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = async () => {
      const [rows] = await sink.query<mysql.RowDataPacket[]>('SELECT source, message, raw_content, detected_patterns FROM database_logs');
      return rows;
    };
    await databaseLogService.collectLogs();
    expect(service.lastCollectTime.get(instance.id)).toBeInstanceOf(Date);
    expect(await logs()).toHaveLength(0);
    const baseline = service.pgLastStats.get(instance.id), time = service.lastCollectTime.get(instance.id);

    worker = new Client({ ...pgConfig, database: name });
    await worker.connect();
    for (let i = 0; i < 25; i++) {
      await worker.query('BEGIN');
      await worker.query('ROLLBACK');
    }
    // Session exit flushes this backend's statistics; no reset of shared database statistics.
    await worker.end();
    worker = undefined;
    await collector.query('SELECT pg_stat_clear_snapshot()');
    const observed = (await collector.query('SELECT xact_rollback FROM pg_stat_database WHERE datname = $1', [name])).rows[0];
    expect(Number(observed.xact_rollback) - baseline.get(name).xact_rollback).toBe(25);

    await sink.query('RENAME TABLE database_logs TO database_logs_unavailable');
    await databaseLogService.collectLogs();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(service.pgLastStats.get(instance.id)).toBe(baseline);
    expect(service.lastCollectTime.get(instance.id)).toBe(time);
    expect(analysis).not.toHaveBeenCalled();
    await sink.query('RENAME TABLE database_logs_unavailable TO database_logs');
    expect(await logs()).toHaveLength(0);

    await databaseLogService.collectLogs();
    const persisted = await logs();
    const rollback = persisted.filter(log => JSON.parse(log.raw_content).datname === name);
    expect(rollback).toHaveLength(1);
    expect(rollback[0].source).toBe('pg_log');
    expect(JSON.parse(rollback[0].raw_content).delta).toBe(25);
    expect(rollback[0].message).toContain('事务回滚异常增多');
    await databaseLogService.collectLogs();
    expect(await logs()).toHaveLength(persisted.length);
    console.log(JSON.stringify({ task: 'MAX-392', postgres: version,
      mysql: (await mysqlAdmin.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version'))[0][0].version,
      sourceDatabase: name, destinationDatabase: name, rollbackDelta: 25, persisted: rollback.length,
      queryTransport: 'real pg.Client', persistence: 'real mysql2 pool; production database_logs schema',
      checks: ['quiet baseline', 'real write failure preserves both baselines', 'real rollback persisted', 'no duplicate on quiet round'],
      modelCalls: 0 }));
  }, 20000);
});
