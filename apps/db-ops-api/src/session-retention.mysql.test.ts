import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatDatabaseService } from './chat-database-service.js';
import { MigrationRunner } from './migrations/runner.js';

// Explicit opt-in, shared with the existing real-MySQL CI candidate.
const port = process.env.INVESTIGATION_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT;
describe.skipIf(!port)('MAX-622 retention with production MySQL schema', () => {
  const database = `max622_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let service: ChatDatabaseService;

  beforeAll(async () => {
    const options = {
      host: process.env.REPORT_TEST_MYSQL_HOST ?? '127.0.0.1',
      port: Number(port),
      user: process.env.REPORT_TEST_MYSQL_USER ?? 'root',
      password: process.env.INVESTIGATION_TEST_MYSQL_PASSWORD ?? process.env.REPORT_TEST_MYSQL_PASSWORD ?? '',
      connectionLimit: 2,
    };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    await new MigrationRunner(pool).run();
    service = new ChatDatabaseService(() => pool);
  }, 30_000);

  afterAll(async () => {
    try { await pool?.end(); }
    finally {
      if (admin) {
        try { await admin.query(`DROP DATABASE IF EXISTS ${database}`); }
        finally { await admin.end(); }
      }
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM investigations');
    await pool.query('DELETE FROM chat_messages');
    await pool.query('DELETE FROM chat_sessions');
    for (const id of ['expired', 'recent', 'protected']) {
      await pool.execute("INSERT INTO chat_sessions (session_id, user_id, title, last_message_at) VALUES (?, 1, ?, NOW())", [id, id]);
      await pool.execute("INSERT INTO chat_messages (session_id, message_id, role, content) VALUES (?, ?, 'user', 'retention fixture')", [id, `message-${id}`]);
    }
    await pool.query("UPDATE chat_sessions SET last_message_at = DATE_SUB(NOW(), INTERVAL 90 DAY) WHERE session_id IN ('expired', 'protected')");
    await pool.execute(`INSERT INTO investigations
      (id, title, goal, profile_id, profile_version, session_id, owner_kind, owner_id, scope_version)
      VALUES (?, 'Protected', 'Retention fixture', 'ops', 1, 'protected', 'user', 1, ?)`, [randomUUID(), 'a'.repeat(64)]);
  });

  const ids = async (table: 'chat_sessions' | 'chat_messages') => {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT session_id FROM ${table} ORDER BY session_id`);
    return rows.map(row => row.session_id);
  };

  it('rejects invalid maintenance values without deleting sessions or messages (#283)', async () => {
    for (const value of [0, -5, NaN, Infinity, 1.5, 36501, Number.MAX_SAFE_INTEGER + 1, undefined, null, '', '30', '30days']) {
      await expect(service.deleteOldSessionsForMaintenance(value as number)).rejects.toThrow(/retention/i);
      expect(await ids('chat_sessions')).toEqual(['expired', 'protected', 'recent']);
      expect(await ids('chat_messages')).toEqual(['expired', 'protected', 'recent']);
    }
  });

  it.each([1, 30, 36500])('safely cleans at %i days and preserves investigation messages', async days => {
    expect(await service.deleteOldSessionsForMaintenance(days)).toBe(days === 36500 ? 0 : 1);
    const retained = days === 36500 ? ['expired', 'protected', 'recent'] : ['protected', 'recent'];
    expect(await ids('chat_sessions')).toEqual(retained);
    expect(await ids('chat_messages')).toEqual(retained);
    expect(await service.deleteOldSessionsForMaintenance(days)).toBe(0);
  });
});
