/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R4 — receipt persistence is a real boundary.
 *
 * On a disposable schema (METRICS_TEST_MYSQL_PORT, never 3306) this runs the
 * real receipt writer, the real policy pool and admission gate, and the real
 * live session read (`ActorContextService.revalidateActorOn`) on the connection
 * the writer already holds. The INSERT is made to wait on a real InnoDB
 * row/gap lock held by another connection; the session is revoked while it
 * waits. The refused write must leave no row (real rollback), and the same path
 * must still insert, replay and refuse a collision when the grant holds.
 *
 * The revocation is a real `session_version` change in this database; it is not
 * a production incident drill.
 */
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActorAuthenticationError, ActorContextService, type ActorContext, type QueryExecutor,
} from '../../auth/actor-context.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import {
  canManageResource, MysqlResourceRelationStore, type SqlQueryExecutor,
} from '../../resources/resource-service.js';
import { writeTrialReceipt, type TrialReceiptExecutor } from './trial-receipt-writer.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const AT = '2026-10-29T17:00:00.000Z';
const RESOURCE = { type: 'instance' as const, id: 1 };
let userId = 0;
const RECEIPT = 'r4-receipt-0001';

const actorFor = (sessionVersion: number): ActorContext => ({
  userId, username: 'admin', roles: ['admin'], permissions: ['*'], sessionVersion,
  instanceScopes: { 1: 'admin' }, requestId: 'req-238-r4',
});

const forbidden = () => Object.assign(new Error('TEMPLATE_BINDING_FORBIDDEN'), { code: 'TEMPLATE_BINDING_FORBIDDEN' });

/** The writer's public authorization: a live session and resource check on the held connection. */
function authorizer(pool: Pool, actor: ActorContext) {
  const contexts = new ActorContextService(() => pool as never);
  const relations = new MysqlResourceRelationStore(() => pool as never);
  let checks = 0;
  const authorize = async (connection?: TrialReceiptExecutor): Promise<void> => {
    checks += 1;
    const current = connection
      ? await contexts.revalidateActorOn(connection as unknown as QueryExecutor, actor, actor.requestId)
      : await contexts.revalidateActor(actor, actor.requestId);
    if (!canManageResource(current, RESOURCE)) throw forbidden();
    const exists = connection
      ? await relations.existsOn!(connection as unknown as SqlQueryExecutor, RESOURCE)
      : await relations.exists(RESOURCE);
    if (!exists) throw new Error('TEMPLATE_BINDING_RESOURCE_NOT_FOUND');
  };
  return { authorize, checks: () => checks };
}

const payload = (receiptId: string, expires = '2026-10-29T17:10:00.000Z') => ({
  receipt_version: 2, receipt_id: receiptId, resource: { type: 'instance', id: '1' },
  base_revision: 4, target_revision: 5,
  candidate_digest: `sha256:${'a'.repeat(64)}`,
  resolution_identity: `sha256:${'a'.repeat(64)}`,
  dependency_digest: `sha256:${'a'.repeat(64)}`,
  issued_at: AT, expires_at: expires, items: [], optional_exclusions: [],
});

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await wait(10);
  }
  throw new Error('fixture: condition not reached');
}

describe.skipIf(!port)('trial receipt persistence on isolated MySQL', () => {
  let root: Pool, pool: Pool;
  const database = `max238r4_${process.pid}`;

  const rowCount = async (receiptId: string): Promise<number> => {
    const [rows] = await pool.execute('SELECT COUNT(*) AS n FROM metric_policy_trial_receipts WHERE receipt_id = ?',
      [receiptId]) as unknown as [Array<{ n: number }>, unknown];
    return Number(rows[0]?.n ?? -1);
  };

  const clear = async () => { await pool.query('DELETE FROM metric_policy_trial_receipts'); };
  const setSession = async (next: number) => {
    await pool.execute('UPDATE users SET session_version = ? WHERE id = ?', [next, userId]);
  };

  /** Block an INSERT of one primary key with a real InnoDB gap/next-key lock. */
  async function lockReceipt(receiptId: string): Promise<PoolConnection> {
    const blocker = await pool.getConnection();
    await blocker.beginTransaction();
    await blocker.execute('SELECT receipt_id FROM metric_policy_trial_receipts WHERE receipt_id = ? FOR UPDATE', [receiptId]);
    return blocker;
  }

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '',
      database, connectionLimit: 8 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    // The baseline seeds the bootstrap admin (role `admin`, permission `*`); this
    // suite only owns its session version.
    const [admins] = await pool.execute('SELECT id FROM users WHERE username = ?', ['admin']) as unknown as
      [Array<{ id: number }>, unknown];
    userId = Number(admins[0]?.id);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('fixture: bootstrap admin missing');
    await pool.execute('UPDATE users SET session_version = 3 WHERE id = ?', [userId]);
    await pool.execute(
      `INSERT INTO database_instances (id, name, environment, db_type, host, port, username, password_encrypted)
       VALUES (1, 'max238-r4-fixture', 'testing', 'mysql', '127.0.0.1', 3306, 'fixture', '')`);
  }, 180000);

  afterAll(async () => {
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  });

  it('rolls the INSERT back when the session is revoked while its row lock waits', async () => {
    await clear();
    await setSession(3);
    const live = authorizer(pool, actorFor(3));
    const blocker = await lockReceipt(RECEIPT);
    try {
      const write = writeTrialReceipt(
        { receipt_id: RECEIPT, payload: payload(RECEIPT) },
        { pool: () => pool, authorize: live.authorize });
      // The pre-INSERT checks passed and the INSERT is now waiting on the blocker.
      await until(() => live.checks() >= 2);
      await wait(150);
      expect(await Promise.race([write.then(() => 'settled'), wait(50).then(() => 'waiting')])).toBe('waiting');

      await setSession(4);
      await blocker.rollback();
      await expect(write).rejects.toBeInstanceOf(ActorAuthenticationError);
    } finally {
      try { await blocker.rollback(); } catch { /* already rolled back */ }
      blocker.release();
    }
    // The refused transaction left no row behind.
    expect(await rowCount(RECEIPT)).toBe(0);

    // The same receipt inserts once under the now-current session: the retry is
    // not blocked by anything the refused transaction left.
    const retry = await writeTrialReceipt(
      { receipt_id: RECEIPT, payload: payload(RECEIPT) },
      { pool: () => pool, authorize: authorizer(pool, actorFor(4)).authorize });
    expect(retry).toEqual({ kind: 'inserted', persisted: true, receipt_id: RECEIPT });
    expect(await rowCount(RECEIPT)).toBe(1);
  }, 30000);

  it('commits once the blocked INSERT finishes under a still-current session', async () => {
    await clear();
    await setSession(4);
    const live = authorizer(pool, actorFor(4));
    const blocker = await lockReceipt(RECEIPT);
    try {
      const write = writeTrialReceipt(
        { receipt_id: RECEIPT, payload: payload(RECEIPT) },
        { pool: () => pool, authorize: live.authorize });
      await until(() => live.checks() >= 2);
      await wait(150);
      expect(await Promise.race([write.then(() => 'settled'), wait(50).then(() => 'waiting')])).toBe('waiting');
      await blocker.rollback();
      await expect(write).resolves.toEqual({ kind: 'inserted', persisted: true, receipt_id: RECEIPT });
    } finally {
      try { await blocker.rollback(); } catch { /* already rolled back */ }
      blocker.release();
    }
    expect(await rowCount(RECEIPT)).toBe(1);
  }, 30000);

  it('discards a refused transaction after the INSERT with a real row readback', async () => {
    await clear();
    await setSession(4);
    let calls = 0;
    const authorize = async () => {
      calls += 1;
      // Post-admission and post-connection hold; the post-INSERT read refuses.
      if (calls >= 3) throw forbidden();
    };
    await expect(writeTrialReceipt({ receipt_id: RECEIPT, payload: payload(RECEIPT) },
      { pool: () => pool, authorize })).rejects.toThrow('TEMPLATE_BINDING_FORBIDDEN');
    expect(calls).toBe(3);
    expect(await rowCount(RECEIPT)).toBe(0);
  });

  it('inserts, replays and refuses a collision against the real primary key', async () => {
    await clear();
    await setSession(4);
    const { authorize } = authorizer(pool, actorFor(4));
    expect(await writeTrialReceipt({ receipt_id: RECEIPT, payload: payload(RECEIPT) },
      { pool: () => pool, authorize }))
      .toEqual({ kind: 'inserted', persisted: true, receipt_id: RECEIPT });
    expect(await writeTrialReceipt({ receipt_id: RECEIPT, payload: payload(RECEIPT) },
      { pool: () => pool, authorize }))
      .toEqual({ kind: 'replay', persisted: false, receipt_id: RECEIPT });
    expect(await writeTrialReceipt({ receipt_id: RECEIPT, payload: payload(RECEIPT, '2026-10-29T17:20:00.000Z') },
      { pool: () => pool, authorize }))
      .toEqual({ kind: 'collision', persisted: false, receipt_id: RECEIPT });
    expect(await rowCount(RECEIPT)).toBe(1);
    const [rows] = await pool.execute('SELECT payload FROM metric_policy_trial_receipts WHERE receipt_id = ?',
      [RECEIPT]) as unknown as [Array<{ payload: unknown }>, unknown];
    const stored = rows[0]!.payload;
    expect(typeof stored === 'string' ? JSON.parse(stored) as unknown : stored).toEqual(payload(RECEIPT));
  }, 30000);
});
