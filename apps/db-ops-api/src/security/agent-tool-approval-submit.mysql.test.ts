import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool } from '../tools/types.js';
import { AgentToolApprovalService, type ApprovalRequestOptions } from './agent-tool-approval-service.js';

// MAX-333 / #298: opt in to a disposable schema, never the application database.
const port = Number(process.env.APPROVAL_TEST_MYSQL_PORT);
describe.skipIf(!port)('approval submit: real MySQL concurrency', () => {
  const database = `approval_submit_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let created = false;
  let delayedReads = 0;
  const connectionOptions = {
    host: process.env.APPROVAL_TEST_MYSQL_HOST ?? '127.0.0.1', port,
    user: process.env.APPROVAL_TEST_MYSQL_USER ?? 'root',
    password: process.env.APPROVAL_TEST_MYSQL_PASSWORD, connectionLimit: 8, timezone: 'Z',
  };
  // Delay AFTER the real SELECT to expose the original SELECT/INSERT race.
  // Apply the same delay to pooled and pinned connections, without a mock DB.
  const execute = async (connection: Pick<Pool, 'execute'>, sql: string, values?: unknown[]) => {
    const result = await connection.execute(sql, values as any[]);
    if (sql.includes('SELECT id, expires_at')) {
      delayedReads += 1;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return result;
  };
  const store = {
    execute: (sql: string, values?: unknown[]) => execute(pool, sql, values),
    getConnection: async () => {
      const connection = await pool.getConnection();
      return {
        execute: (sql: string, values?: unknown[]) => execute(connection, sql, values),
        release: () => connection.release(), destroy: () => connection.destroy(),
      };
    },
  };
  const actor: ActorContext = {
    userId: 7, username: 'approval-test', roles: ['dba'], permissions: ['instance:update'],
    sessionVersion: 1, instanceScopes: {}, requestId: 'max-333',
  };
  const tool: AnyAgentTool = {
    name: 'slide_update_db_config', description: 'test',
    parameters: { type: 'object', properties: {} }, handler: async () => ({ success: true }),
  };
  const resource = { type: 'instance' as const, instanceId: 12 };
  const service = () => new AgentToolApprovalService(() => store, 'max-333-test-hmac-key');
  const submit = (options: ApprovalRequestOptions = {}) => service().submit(actor, tool, { instance_id: 12 }, resource, options);

  beforeAll(async () => {
    pool = mysql.createPool(connectionOptions);
    await pool.query(`CREATE DATABASE ${database}`);
    created = true;
    await pool.end();
    pool = mysql.createPool({ ...connectionOptions, database });
    pool.on('connection', connection => { connection.query("SET time_zone = '+00:00'"); });
    await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES (7), (8)');
    for (const name of ['054_agent_tool_approvals', '068_agent_tool_approval_scopes']) {
      await pool.query(await readFile(new URL(`../../sql/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    const [environment] = await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation_level, @@autocommit AS autocommit, @@session.time_zone AS time_zone');
    console.info('MAX-333 isolated schema:', database, 'environment:', environment);
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM agent_tool_approvals');
    delayedReads = 0;
  });
  afterAll(async () => {
    if (created) {
      await pool.query(`DROP DATABASE ${database}`);
      const [remaining] = await pool.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
      expect(remaining).toEqual([]);
      console.info('MAX-333 schema cleanup verified:', database);
    }
    await pool?.end();
  });

  it('returns one pending ID and stored expiry across 24 competing service instances', async () => {
    const results = await Promise.all(Array.from({ length: 24 }, () => submit()));
    expect(delayedReads).toBe(24);
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    // MySQL DATETIME rounds away milliseconds; every returned expiry must match storage.
    const [rows] = await pool.query<any[]>('SELECT id, status, expires_at FROM agent_tool_approvals');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(results.every(result => result.expiresAt.getTime() === rows[0].expires_at.getTime())).toBe(true);
  });

  it.each(['approved', 'rejected', 'consumed', 'expired', 'past-expiry'])(
    'allows a fresh concurrent submission after %s', async status => {
      const old = await submit();
      if (status === 'past-expiry') {
        await pool.query('UPDATE agent_tool_approvals SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?', [old.id]);
      } else {
        await pool.query('UPDATE agent_tool_approvals SET status = ? WHERE id = ?', [status, old.id]);
      }
      const results = await Promise.all(Array.from({ length: 8 }, () => submit()));
      expect(new Set(results.map(result => result.id)).size).toBe(1);
      expect(results[0].id).not.toBe(old.id);
      const [rows] = await pool.query<any[]>("SELECT id FROM agent_tool_approvals WHERE status = 'pending' AND expires_at > NOW()");
      expect(rows).toHaveLength(1);
    },
  );

  it('isolates normalized scope, exact session, risk ceiling and use allowance', async () => {
    const variants: ApprovalRequestOptions[] = [
      { scope: 'once', riskLevel: 'medium', sessionKey: 'Session-A' },
      { scope: 'window', riskLevel: 'medium', sessionKey: 'Session-A' },
      { scope: 'session', riskLevel: 'medium', sessionKey: 'Session-A' },
      { scope: 'session', riskLevel: 'medium', sessionKey: 'session-a' },
      { scope: 'session', riskLevel: 'medium', sessionKey: 'Session-B' },
      { scope: 'once', riskLevel: 'high', sessionKey: 'Session-A' },
      { scope: 'once', riskLevel: 'medium', sessionKey: 'Session-A', maxUses: 2 },
      { scope: 'once', riskLevel: 'medium' },
    ];
    const results = await Promise.all(variants.map(options => submit(options)));
    expect(new Set(results.map(result => result.id)).size).toBe(variants.length);
    const retries = await Promise.all(variants.map(options => submit(options)));
    expect(retries.map(result => result.id)).toEqual(results.map(result => result.id));
    // High risk is normalized to once; requesting a window cannot widen the grant.
    expect((await submit({ scope: 'window', riskLevel: 'high', sessionKey: 'Session-A' })).id).toBe(results[5].id);
  });

  it('does not reuse pending approvals of another requester or resource binding', async () => {
    const first = await submit();
    const otherActor = await service().submit({ ...actor, userId: 8 }, tool, { instance_id: 12 }, resource);
    const otherResource = await service().submit(actor, tool, { instance_id: 13 }, { type: 'instance', instanceId: 13 });
    expect(new Set([first.id, otherActor.id, otherResource.id]).size).toBe(3);
  });

  it('releases the lock after a failed insert so a later request can succeed', async () => {
    await expect(service().submit({ ...actor, userId: 999 }, tool, {}, resource)).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await pool.query('INSERT INTO users VALUES (999)');
    try {
      const result = await service().submit({ ...actor, userId: 999 }, tool, {}, resource);
      expect(result.id).toMatch(/^\d+$/);
    } finally {
      await pool.query('DELETE FROM users WHERE id = 999');
    }
  });
});
