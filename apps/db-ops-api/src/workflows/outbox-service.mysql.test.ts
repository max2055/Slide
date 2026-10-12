import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitSqlStatements } from '../migrations/runner.js';
import { OutboxService, type OutboxInput, type TransactionPool } from './outbox-service.js';

const port = Number(process.env.REPORT_TEST_MYSQL_PORT);
describe.skipIf(!port)('outbox in isolated MySQL', () => {
  let admin: Pool;
  let pool: Pool;
  let service: OutboxService;
  const database = `outbox_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const event: OutboxInput = { eventType: 'report.ready', schemaVersion: 1, aggregateType: 'report',
    aggregateId: '1', aggregateVersion: 1, payload: { value: 'original' }, idempotencyKey: 'report:1' };

  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root',
      password: process.env.REPORT_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 10 });
    for (const sql of splitSqlStatements(readFileSync(new URL('../../sql/migrations/032_workflow_outbox_jobs.sql', import.meta.url), 'utf8'))) {
      await pool.query(sql);
    }
    await pool.query('CREATE TABLE business_rows (id CHAR(36) PRIMARY KEY, event_id CHAR(36)) ENGINE=InnoDB');
    service = new OutboxService(pool as unknown as TransactionPool);
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM business_rows');
    await pool.query('DELETE FROM outbox_events');
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
  const rows = async () => (await pool.query<mysql.RowDataPacket[]>('SELECT id, payload FROM outbox_events'))[0];

  it('returns the actual durable ID on first and repeated append without changing the payload', async () => {
    const first = await service.transaction(async (_connection, append) => append(event));
    const second = await service.transaction(async (_connection, append) => append({ ...event, payload: { value: 'retry' } }));
    expect(second).toBe(first);
    expect(await rows()).toEqual([{ id: first, payload: { value: 'original' } }]);
  });

  it('100 concurrent same-key appends return one durable ID that every business row can reference', async () => {
    const ids = await Promise.all(Array.from({ length: 100 }, () => service.transaction(async (connection, append) => {
      const id = await append(event);
      await connection.execute('INSERT INTO business_rows (id, event_id) VALUES (?, ?)', [randomUUID(), id]);
      return id;
    })));
    expect(new Set(ids).size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].id).toBe(ids[0]);
    const [result] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count, SUM(o.id IS NULL) AS orphans FROM business_rows b LEFT JOIN outbox_events o ON o.id = b.event_id');
    expect(Number(result[0].count)).toBe(100);
    expect(Number(result[0].orphans)).toBe(0);
  });

  it('rolls back business and event rows on SQL failure, then allows a clean retry', async () => {
    await expect(service.transaction(async (connection, append) => {
      const id = await append(event);
      await connection.execute('INSERT INTO business_rows (id, event_id) VALUES (?, ?)', ['business', id]);
      // Inject a real MySQL duplicate-key error after both writes.
      await connection.execute('INSERT INTO business_rows (id, event_id) VALUES (?, ?)', ['business', id]);
    })).rejects.toThrow('Duplicate entry');
    expect(await rows()).toHaveLength(0);
    expect((await pool.query<mysql.RowDataPacket[]>('SELECT * FROM business_rows'))[0]).toHaveLength(0);
    const id = await service.transaction(async (_connection, append) => append(event));
    expect((await rows())[0].id).toBe(id);
  });

  it('releases a real pooled connection after a MySQL failure at transaction startup', async () => {
    const connection = await pool.getConnection();
    const release = vi.spyOn(connection, 'release');
    const [identity] = await connection.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
    // Kill only this test-owned connection; beginTransaction itself is real.
    await admin.query(`KILL CONNECTION ${Number(identity[0].id)}`);
    const work = vi.fn();
    try {
      await expect(new OutboxService({ getConnection: async () => connection as unknown as Awaited<ReturnType<TransactionPool['getConnection']>> })
        .transaction(work)).rejects.toThrow();
      expect(release).toHaveBeenCalledOnce();
      expect(work).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(0);
    } finally {
      if (release.mock.calls.length === 0) connection.release();
      release.mockRestore();
    }
    const id = await service.transaction(async (_connection, append) => append(event));
    expect((await rows())[0].id).toBe(id);
  });

  it('finds an existing ID even when the transaction snapshot predates its commit', async () => {
    const connection = await pool.getConnection();
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    let persistedId = '';
    const snapshotService = new OutboxService({ getConnection: async () => connection as unknown as Awaited<ReturnType<TransactionPool['getConnection']>> });
    const id = await snapshotService.transaction(async (current, append) => {
      const [snapshot] = await current.execute('SELECT id FROM outbox_events') as [unknown[]];
      expect(snapshot).toHaveLength(0);
      persistedId = await service.transaction(async (_connection, innerAppend) => innerAppend(event));
      return append(event);
    });
    expect(id).toBe(persistedId);
    expect((await rows())[0].id).toBe(persistedId);
  });
});
