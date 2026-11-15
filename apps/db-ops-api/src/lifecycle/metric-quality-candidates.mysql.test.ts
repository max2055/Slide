import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../migrations/runner.js';

// Explicit opt-in; ordinary test collection never reads local credentials or .env.
const enabled = process.env.MAX7_MYSQL_ACCEPTANCE === '1';
const statements = splitSqlStatements(readFileSync(
  new URL('../../sql/diagnostics/metric-quality-candidates.sql', import.meta.url), 'utf8'));

describe.skipIf(!enabled)('GitHub #470 candidate export snapshot (real MySQL)', () => {
  const database = `max7_candidates_${randomUUID().replaceAll('-', '')}`;
  let admin: Connection | undefined;
  let reader: Connection | undefined;
  let writer: Connection | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    const { MAX7_MYSQL_HOST: host, MAX7_MYSQL_PORT: portText,
      MAX7_MYSQL_USER: user, MAX7_MYSQL_PASSWORD: password } = process.env;
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || password === undefined) {
      throw new Error('MAX7_MYSQL_ACCEPTANCE=1 requires explicit MAX7_MYSQL_HOST/PORT/USER/PASSWORD');
    }
    const config = { host, port, user, password, connectTimeout: 5_000, dateStrings: true };
    admin = await mysql.createConnection(config);
    await admin.query(`CREATE DATABASE ${database}`);
    databaseCreated = true;
    writer = await mysql.createConnection({ ...config, database });
    reader = await mysql.createConnection({ ...config, database });
    await writer.query('SET SESSION innodb_lock_wait_timeout = 2');
    const baseline = readFileSync(new URL('../../sql/migrations/000_schema_baseline.sql', import.meta.url), 'utf8');
    const table = splitSqlStatements(baseline).find(sql => /CREATE TABLE IF NOT EXISTS `metrics_history`/.test(sql));
    if (!table) throw new Error('metrics_history baseline not found');
    await writer.query(table);
    const [engines] = await writer.query<RowDataPacket[]>(
      'SELECT ENGINE FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [database, 'metrics_history']);
    expect(engines[0].ENGINE).toBe('InnoDB');
  });

  afterAll(async () => {
    try {
      await reader?.end();
    } finally {
      try {
        await writer?.end();
      } finally {
        if (admin) {
          try {
            if (databaseCreated) await admin.query(`DROP DATABASE ${database}`);
          } finally {
            await admin.end();
          }
        }
      }
    }
  });

  beforeEach(async () => {
    await writer!.query('DELETE FROM metrics_history');
    await writer!.query(`INSERT INTO metrics_history (id, instance_id, is_estimated, recorded_at, qps) VALUES
      (1, 9, TRUE, '2020-01-01 00:00:00', 11.25),
      (2, 9, TRUE, '2020-02-01 00:00:00', 22.50),
      (3, 9, FALSE, '2020-03-01 00:00:00', 33.75),
      (4, 9, NULL, '2020-04-01 00:00:00', 44.50)`);
  });

  for (const isolation of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
    for (const mutation of ['insert', 'delete']) {
      it(`${isolation}: summary and details retain one snapshot across concurrent ${mutation}`, async () => {
        await reader!.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${isolation}`);
        const [before] = await writer!.query<RowDataPacket[]>('SELECT * FROM metrics_history ORDER BY id');
        const resultSets: RowDataPacket[][] = [];
        try {
          for (const statement of statements) {
            const [rows] = await reader!.query(statement);
            if (!Array.isArray(rows)) continue;
            resultSets.push(rows as RowDataPacket[]);
            if (resultSets.length === 1) {
              // A separate connection commits between the two actual script reads.
              await writer!.beginTransaction();
              if (mutation === 'insert') {
                await writer!.query(`INSERT INTO metrics_history (id, instance_id, is_estimated, recorded_at, qps)
                  VALUES (5, 9, TRUE, '2021-01-01 00:00:00', 55.25)`);
              } else {
                await writer!.query('DELETE FROM metrics_history WHERE id = 1');
              }
              await writer!.commit();
            }
          }
          expect(resultSets).toHaveLength(2);
          const [summary, details] = resultSets;
          expect(summary[0].candidate_count).toBe(details.length);
          expect(details.map(row => row.id)).toEqual([1, 2]);
          expect(summary[0].earliest_recorded_at).toBe(details[0].recorded_at);
          expect(summary[0].latest_recorded_at).toBe(details[1].recorded_at);
          const [after] = await writer!.query<RowDataPacket[]>('SELECT * FROM metrics_history ORDER BY id');
          // Only the independent writer's known insert/delete may change history.
          expect(after.filter(row => row.id !== 5)).toEqual(
            before.filter(row => mutation !== 'delete' || row.id !== 1));
          expect(after).toHaveLength(mutation === 'insert' ? 5 : 3);
          const [session] = await reader!.query<RowDataPacket[]>('SELECT @@session.transaction_isolation AS isolation');
          expect(session[0].isolation).toBe(isolation.replaceAll(' ', '-'));
        } finally {
          await reader!.rollback();
          await writer!.rollback();
        }
      }, 10_000);
    }
  }

  it('rejects writes during export and preserves all historical values', async () => {
    await reader!.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const [before] = await writer!.query('SELECT * FROM metrics_history ORDER BY id');
    try {
      for (const statement of statements) {
        await reader!.query(statement);
        if (/START TRANSACTION/i.test(statement)) {
          await expect(reader!.query('UPDATE metrics_history SET is_estimated = FALSE WHERE id = 1'))
            .rejects.toMatchObject({ code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' });
        }
      }
      expect((await writer!.query('SELECT * FROM metrics_history ORDER BY id'))[0]).toEqual(before);
    } finally {
      await reader!.rollback();
    }
  });

  it('exports an empty candidate set consistently', async () => {
    await writer!.query('DELETE FROM metrics_history WHERE is_estimated = TRUE');
    await reader!.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const results: RowDataPacket[][] = [];
    try {
      for (const statement of statements) {
        const [rows] = await reader!.query(statement);
        if (Array.isArray(rows)) results.push(rows as RowDataPacket[]);
      }
      expect(results).toEqual([[expect.objectContaining({
        candidate_count: 0, earliest_recorded_at: null, latest_recorded_at: null,
      })], []]);
    } finally {
      await reader!.rollback();
    }
  });
});
