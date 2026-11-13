import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { AgentToolApprovalService } from './agent-tool-approval-service.js';
import { registerAgentToolApprovalRoutes } from './agent-tool-approval-routes.js';

// MAX-351: opt-in disposable schema, real migrations and real HTTP/service writes.
const port = Number(process.env.APPROVAL_TEST_MYSQL_PORT);
describe.skipIf(!port)('atomic batch reviews: real MySQL', () => {
  const database = `approval_batch_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let created = false;
  const service = () => new AgentToolApprovalService(() => pool as any, 'max351-test-hmac-key');
  const rows = async () => (await pool.query<any[]>('SELECT id, status, reviewer_id, review_note FROM agent_tool_approvals ORDER BY id'))[0];
  beforeAll(async () => {
    const options = { host: process.env.APPROVAL_TEST_MYSQL_HOST ?? '127.0.0.1', port,
      user: process.env.APPROVAL_TEST_MYSQL_USER ?? 'root', password: process.env.APPROVAL_TEST_MYSQL_PASSWORD };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    pool = mysql.createPool({ ...options, database, connectionLimit: 6 });
    await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES (7), (9)');
    for (const migration of ['054_agent_tool_approvals', '068_agent_tool_approval_scopes']) {
      await pool.query(await readFile(new URL(`../../sql/migrations/${migration}.sql`, import.meta.url), 'utf8'));
    }
    console.info('MAX-351 MySQL', (await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation_level'))[0]);
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS batch_failure');
    await pool.query('DELETE FROM agent_tool_approvals');
    for (const id of [41, 42, 43]) {
      await pool.execute(`INSERT INTO agent_tool_approvals
        (id, tool_name, requester_id, binding_hash, args_redacted, resource_json, policy_snapshot, expires_at)
        VALUES (?, 'execute_code', 7, ?, '{}', '{}', '{}', NOW() + INTERVAL 1 HOUR)`, [id, 'a'.repeat(64)]);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    await pool?.end();
    if (created) {
      await admin.query(`DROP DATABASE ${database}`);
      expect((await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]))[0]).toEqual([]);
      console.info('MAX-351 isolated schema cleanup verified');
    }
    await admin?.end();
  });

  it.each([41, 42, 43])('rolls back every row on a real trigger failure at ID %i and permits an explicit retry', async id => {
    await pool.query(`CREATE TRIGGER batch_failure BEFORE UPDATE ON agent_tool_approvals FOR EACH ROW
      BEGIN IF OLD.id = ${id} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'batch failure'; END IF; END`);
    await expect(service().reviewPendingByTool('execute_code', 9, 'approve')).rejects.toThrow('batch failure');
    expect((await rows()).map(row => [row.status, row.reviewer_id, row.review_note]))
      .toEqual(Array.from({ length: 3 }, () => ['pending', null, null]));
    await pool.query('DROP TRIGGER batch_failure');
    expect(await service().reviewPendingByTool('execute_code', 9, 'reject', 'retry')).toEqual(['41', '42', '43']);
    expect((await rows()).every(row => row.status === 'rejected' && row.review_note === 'retry')).toBe(true);
  });

  it('observes a concurrent committed status change while waiting for the row lock', async () => {
    const other = await pool.getConnection();
    await other.beginTransaction();
    await other.query("UPDATE agent_tool_approvals SET status = 'rejected' WHERE id = 42");
    let selected!: () => void;
    const selecting = new Promise<void>(resolve => { selected = resolve; });
    const wrapped = { execute: pool.execute.bind(pool), getConnection: async () => {
      const connection = await pool.getConnection();
      return { release: () => connection.release(), destroy: () => connection.destroy(),
        beginTransaction: () => connection.beginTransaction(), rollback: () => connection.rollback(),
        commit: () => connection.commit(),
        execute: async (sql: string, values?: unknown[]) => {
          const pending = connection.execute(sql, values as any[]);
          if (sql.includes('FOR UPDATE')) selected();
          return pending;
        } };
    } };
    const batch = new AgentToolApprovalService(() => wrapped, 'max351-test-hmac-key')
      .reviewPendingByTool('execute_code', 9, 'approve');
    try {
      await selecting;
      await other.commit();
      expect(await batch).toEqual(['41', '43']);
      expect((await rows()).map(row => row.status)).toEqual(['approved', 'rejected', 'approved']);
    } finally { await other.rollback(); other.release(); }
  });

  it('serializes competing batches so each ID is reviewed once', async () => {
    const results = await Promise.all([service().reviewPendingByTool('execute_code', 9, 'approve'),
      service().reviewPendingByTool('execute_code', 9, 'reject')]);
    expect(results.flat().sort()).toEqual(['41', '42', '43']);
    expect(new Set((await rows()).map(row => row.status)).size).toBe(1);
  });

  it('returns a sanitized HTTP failure with no completed reviews, then succeeds on explicit retry', async () => {
    vi.stubEnv('AGENT_APPROVAL_HMAC_KEY', 'max351-synthetic-hmac-key-32-characters');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.query(`CREATE TRIGGER batch_failure BEFORE UPDATE ON agent_tool_approvals FOR EACH ROW
      BEGIN IF OLD.id = 42 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'internal synthetic detail'; END IF; END`);
    const app = Fastify();
    await registerAgentToolApprovalRoutes(app, async request => {
      (request as any).user = { userId: 9, roles: ['admin'], permissions: ['approval:approve'] };
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const post = () => fetch(`${address}/api/agent/approvals/batch-review`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolName: 'execute_code', action: 'reject' }) });
      const failed = await post();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ reasonCode: 'AGENT_APPROVAL_BATCH_REVIEW_FAILED' });
      expect((await rows()).map(row => row.status)).toEqual(['pending', 'pending', 'pending']);
      await pool.query('DROP TRIGGER batch_failure');
      const success = await post();
      expect(success.status).toBe(200);
      expect(await success.json()).toMatchObject({ approvalIds: ['41', '42', '43'], count: 3, success: true });
      expect((await rows()).map(row => row.status)).toEqual(['rejected', 'rejected', 'rejected']);
    } finally { await app.close(); }
  });

  it('keeps the existing batch limit and excludes expired and action-plan records', async () => {
    await pool.query("UPDATE agent_tool_approvals SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = 41");
    await pool.query("UPDATE agent_tool_approvals SET tool_name = 'operations_action_plan' WHERE id = 42");
    for (let id = 100; id < 201; id++) {
      await pool.query(`INSERT INTO agent_tool_approvals (id, tool_name, requester_id, binding_hash,
        args_redacted, resource_json, policy_snapshot, expires_at)
        VALUES (?, 'execute_code', 7, ?, '{}', '{}', '{}', NOW() + INTERVAL 1 HOUR)`, [id, 'b'.repeat(64)]);
    }
    expect(await service().reviewPendingByTool('operations_action_plan', 9, 'approve')).toEqual([]);
    const ids = await service().reviewPendingByTool('execute_code', 9, 'approve');
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 2)).toEqual(['43', '100']);
    expect((await rows()).filter(row => row.status === 'pending').map(row => row.id)).toEqual([41, 42, 199, 200]);
  });

  it('reports a lost COMMIT acknowledgement over real HTTP and reconciles committed rows', async () => {
    vi.stubEnv('AGENT_APPROVAL_HMAC_KEY', 'max351-synthetic-hmac-key-32-characters');
    let commits = 0;
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: pool.execute.bind(pool), getConnection: async () => {
      const connection: PoolConnection = await pool.getConnection();
      return { release: () => connection.release(), destroy: () => connection.destroy(),
        beginTransaction: () => connection.beginTransaction(), rollback: () => connection.rollback(),
        commit: async () => { await connection.commit(); commits++; throw new Error('synthetic lost acknowledgement'); },
        execute: async (sql: string, values?: unknown[]) => {
          const result = await connection.execute(sql, values as any[]);
          return result;
        } };
    } } as any);
    const app = Fastify();
    await registerAgentToolApprovalRoutes(app, async request => {
      (request as any).user = { userId: 9, roles: ['admin'], permissions: ['approval:approve'] };
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${address}/api/agent/approvals/batch-review`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolName: 'execute_code', action: 'approve' }) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ reasonCode: 'AGENT_APPROVAL_BATCH_REVIEW_OUTCOME_UNKNOWN' });
      expect(commits).toBe(1);
      expect((await rows()).map(row => row.status)).toEqual(['approved', 'approved', 'approved']);
      expect(await service().reviewPendingByTool('execute_code', 9, 'approve')).toEqual([]);
    } finally { await app.close(); }
  });
});
