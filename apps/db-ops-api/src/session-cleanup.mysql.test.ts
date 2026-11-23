import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDatabaseService } from './chat-database-service.js';
import { runCleanup } from './session-cleanup.js';
import { MigrationRunner } from './migrations/runner.js';

// Explicit opt-in; CI and local acceptance inject credentials, never read private files.
const port = process.env.INVESTIGATION_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT;
describe.skipIf(!port)('MAX-623/#381/#592 maintenance with production MySQL schema', () => {
  const database = `max623_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let service: ChatDatabaseService;
  beforeAll(async () => {
    const started = Date.now();
    const options = {
      host: process.env.REPORT_TEST_MYSQL_HOST ?? '127.0.0.1', port: Number(port),
      user: process.env.REPORT_TEST_MYSQL_USER ?? 'root',
      password: process.env.INVESTIGATION_TEST_MYSQL_PASSWORD ?? process.env.REPORT_TEST_MYSQL_PASSWORD ?? '',
      connectionLimit: 2,
    };
    admin = mysql.createPool(options);
    await admin.query('SELECT 1');
    console.log(`[MAX-623] MySQL connected in ${Date.now() - started}ms`);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    console.log(`[MAX-623] Isolated schema created in ${Date.now() - started}ms`);
    await new MigrationRunner(pool).run();
    console.log(`[MAX-623] Production migrations complete in ${Date.now() - started}ms`);
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
    await pool.query('DELETE FROM agent_runs');
    await pool.query('DELETE FROM chat_messages');
    await pool.query('DELETE FROM chat_sessions');
  });
  const seed = async (ids: string[], messageCount = 3) => {
    await pool.query('INSERT INTO chat_sessions (session_id, user_id, title, last_message_at) VALUES ?',
      [ids.map(id => [id, 1, id, new Date()])]);
    await pool.query('INSERT INTO chat_messages (session_id, message_id, role, content) VALUES ?',
      [ids.flatMap(id => Array.from({ length: messageCount }, (_, i) => [id, `${id}-${i}`, 'user', 'fixture']))]);
  };
  const count = async (id: string) => {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ?', [id]);
    return Number(rows[0].cnt);
  };
  const metadata = async (id: string) => {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT metadata FROM chat_sessions WHERE session_id = ?', [id]);
    return typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
  };
  const fact = async (id: string) => {
    await pool.query(`INSERT INTO agent_canonical_facts (session_id, message_id, turn_sequence, ordinal, entry_json)
      SELECT session_id, CONCAT(session_id, '-fact'), id, 0, JSON_OBJECT('fixture', true)
      FROM chat_messages WHERE session_id = ? ORDER BY id LIMIT 1`, [id]);
  };

  it('skips each protected session, reaches older sessions beyond 1000, and repeats safely', async () => {
    const ordinary = Array.from({ length: 1001 }, (_, i) => `ordinary-${i}`);
    await seed([...ordinary, 'investigation', 'audit', 'pending', 'running']);
    await pool.query(`INSERT INTO agent_runs
      (id, actor_id, session_id, message_id, idempotency_key, state, expires_at)
      VALUES (?, 1, 'running', 'running-2', 'fixture', 'running', DATE_ADD(NOW(), INTERVAL 1 DAY))`, [randomUUID()]);
    const pending = { canonicalRuntimeCheckpoint: { pendingToolCalls: [{ id: 'unsettled' }] } };
    const audit = { canonicalRetentionBoundaries: Array.from({ length: 1000 }, () => ({ beforeSequence: 1 })) };
    await pool.query('UPDATE chat_sessions SET metadata = ? WHERE session_id = ?', [JSON.stringify(pending), 'pending']);
    await pool.query('UPDATE chat_sessions SET metadata = ? WHERE session_id = ?', [JSON.stringify(audit), 'audit']);
    await pool.query(`INSERT INTO investigations
      (id, title, goal, profile_id, profile_version, session_id, owner_kind, owner_id, scope_version)
      VALUES (?, 'Protected', 'Fixture', 'ops', 1, 'investigation', 'user', 1, ?)`, [randomUUID(), 'a'.repeat(64)]);
    await fact('pending');
    await fact('ordinary-0');
    expect(await runCleanup(30, 2, { store: service })).toEqual({ processed: 1001, skipped: 4, failed: 0, deletedMessages: 1001 });
    const [rows] = await pool.query<RowDataPacket[]>('SELECT session_id, COUNT(*) AS cnt FROM chat_messages GROUP BY session_id');
    for (const row of rows) expect(Number(row.cnt)).toBe(ordinary.includes(row.session_id) ? 2 : 3);
    expect(rows).toHaveLength(1005);
    expect(await metadata('pending')).toEqual(pending);
    expect(await metadata('audit')).toEqual(audit);
    expect((await metadata('ordinary-0')).canonicalRetentionBoundaries).toHaveLength(1);
    const [facts] = await pool.query<RowDataPacket[]>('SELECT session_id FROM agent_canonical_facts');
    expect(facts.map(row => row.session_id)).toEqual(['pending']);
    expect(await runCleanup(30, 2, { store: service })).toEqual({ processed: 1001, skipped: 4, failed: 0, deletedMessages: 0 });
    expect((await metadata('ordinary-0')).canonicalRetentionBoundaries).toHaveLength(1);
  }, 30_000);

  it('continues after a concurrent deletion between enumeration and lock', async () => {
    await seed(['eligible', 'deleted']);
    const store = {
      deleteOldSessionsForMaintenance: service.deleteOldSessionsForMaintenance.bind(service),
      getSessionsForMaintenance: service.getSessionsForMaintenance.bind(service),
      enforceMessageCapForMaintenance: async (id: string, max: number) => {
        if (id === 'deleted') await pool.query('DELETE FROM chat_sessions WHERE session_id = ?', [id]);
        return service.enforceMessageCapForMaintenance(id, max);
      },
    };
    expect(await runCleanup(30, 2, { store, batchSize: 1 })).toEqual({ processed: 1, skipped: 1, failed: 0, deletedMessages: 1 });
    expect(await count('eligible')).toBe(2);
  });

  it('rolls back a single deadlock and caps the rest of the current and next pages (#1017)', async () => {
    await seed(['next-page', 'same-page']);
    await seed(['deadlocked'], 20);
    await fact('deadlocked');
    const blocker = await pool.getConnection();
    let competingLock: Promise<unknown> | undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await blocker.query('SET SESSION innodb_lock_wait_timeout = 5');
      await blocker.beginTransaction();
      const contended = new ChatDatabaseService(() => ({
        query: pool.query.bind(pool),
        getConnection: async () => {
          const connection = await pool.getConnection();
          const query = connection.query.bind(connection);
          vi.spyOn(connection, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
            if (!competingLock && sql.includes('DELETE cm FROM chat_messages')) {
              // The cap holds the session lock and has already updated audit metadata and deleted the fact.
              // Modify more rows than the cap so InnoDB chooses the cap as the victim.
              await blocker.query('UPDATE chat_messages SET content = ? WHERE session_id = ?', ['competing', 'deadlocked']);
              competingLock = blocker.query('SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE', ['deadlocked'])
                .finally(() => blocker.rollback());
              void competingLock.catch(() => {});
            }
            return query(sql, values);
          }) as typeof connection.query);
          return connection;
        },
      }));
      expect(await runCleanup(30, 2, { store: contended, batchSize: 2 }))
        .toEqual({ processed: 2, skipped: 0, failed: 1, deletedMessages: 2 });
      await competingLock;
      expect(warn).toHaveBeenCalledExactlyOnceWith('[SessionCleanup] Message cap failed for session', {
        sessionId: 'deadlocked', code: 'CHAT_MAINTENANCE_CAP_DEADLOCK',
      });
      expect(await count('deadlocked')).toBe(20);
      expect(await metadata('deadlocked')).toBeNull();
      const [facts] = await pool.query<RowDataPacket[]>('SELECT session_id FROM agent_canonical_facts');
      expect(facts.map(row => row.session_id)).toEqual(['deadlocked']);
      expect(await count('same-page')).toBe(2);
      expect(await count('next-page')).toBe(2);
      expect(await runCleanup(30, 2, { store: service, batchSize: 2 }))
        .toEqual({ processed: 3, skipped: 0, failed: 0, deletedMessages: 18 });
    } finally {
      warn.mockRestore();
      await competingLock?.catch(() => {});
      blocker.destroy();
    }
  }, 10_000);

  it('rolls back audit, facts and messages on storage failure and stops the traversal', async () => {
    await seed(['later', 'broken']);
    await fact('broken');
    const failure = Object.assign(new Error('injected connection loss before message deletion'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const failing = new ChatDatabaseService(() => ({
      query: pool.query.bind(pool),
      getConnection: async () => {
        const connection = await pool.getConnection();
        return {
          beginTransaction: connection.beginTransaction.bind(connection),
          commit: connection.commit.bind(connection), rollback: connection.rollback.bind(connection),
          release: connection.release.bind(connection), destroy: connection.destroy.bind(connection),
          query: (async (sql: string, values?: unknown[]) => {
            if (sql.includes('DELETE cm FROM chat_messages')) throw failure;
            return connection.query(sql, values);
          }) as typeof pool.query,
        };
      },
    }));
    await expect(runCleanup(30, 2, { store: failing })).rejects.toBe(failure);
    expect(await metadata('broken')).toBeNull();
    expect(await count('broken')).toBe(3);
    expect(await count('later')).toBe(3);
    const [facts] = await pool.query<RowDataPacket[]>('SELECT session_id FROM agent_canonical_facts');
    expect(facts.map(row => row.session_id)).toEqual(['broken']);
    expect((await runCleanup(30, 2, { store: service })).deletedMessages).toBe(2);
  });

  it('reads a pending checkpoint committed by a concurrent session lock holder', async () => {
    await seed(['locked']);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE', ['locked']);
      const cleanup = runCleanup(30, 2, { store: service });
      await connection.query('UPDATE chat_sessions SET metadata = ? WHERE session_id = ?',
        [JSON.stringify({ canonicalRuntimeCheckpoint: { pending_tool_calls: [{ id: 'intent' }] } }), 'locked']);
      await connection.commit();
      expect(await cleanup).toEqual({ processed: 0, skipped: 1, failed: 0, deletedMessages: 0 });
      expect(await count('locked')).toBe(3);
    } finally {
      await connection.rollback();
      connection.release();
    }
  });
});
