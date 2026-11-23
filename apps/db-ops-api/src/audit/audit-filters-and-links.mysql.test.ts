import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createActorBoundToolRegistry, getPlatformTool, loadPlatformTools } from '../adapter/get-agent-engine.js';
import { createVerifyToken } from '../auth-middleware.js';
import { actorContextService, signAccessToken } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { loadMigrations, MigrationRunner } from '../migrations/runner.js';
import { registerAgentSecurityRoutes } from '../security/agent-security-routes.js';
import { AuditLogManager, DatabaseAuditLogStore, MemoryAuditLogStore, type AuditLogEntry } from './audit-log.js';
import { registerSystemAuditRoutes } from './system-audit-routes.js';

const invocationMigration = '167_agent_tool_audit_invocation.sql';

describe.skipIf(process.env.AUDIT_BOUNDARY_MYSQL !== '1')('MAX-729 audit HTTP routes on isolated MySQL', () => {
  const database = `max729_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  const readerId = 705;
  const instanceId = 501;
  let admin: Pool | undefined;
  let pool: Pool;
  let app: FastifyInstance;
  let token: string;
  let created = false;
  let store: DatabaseAuditLogStore;
  const memory = new MemoryAuditLogStore();

  beforeAll(async () => {
    if (!process.env.AUDIT_BOUNDARY_MYSQL_CONFIG) throw new Error('AUDIT_BOUNDARY_MYSQL_CONFIG required');
    const { host, port, user, password } = JSON.parse(process.env.AUDIT_BOUNDARY_MYSQL_CONFIG);
    admin = mysql.createPool({ host, port, user, password });
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    pool = mysql.createPool({ host, port, user, password, database });

    const previousDirectory = await mkdtemp(join(tmpdir(), 'slide-audit-migrations-'));
    try {
      for (const migration of await loadMigrations()) {
        if (migration.id < invocationMigration) await writeFile(join(previousDirectory, migration.id), migration.sql);
      }
      await new MigrationRunner(pool, previousDirectory).run();
    } finally {
      await rm(previousDirectory, { recursive: true, force: true });
    }
    await pool.query("INSERT INTO users (id, username, password_hash, status) VALUES (?, 'max729-reader', 'test-only', 'active')", [readerId]);
    await pool.query("INSERT INTO roles (name) VALUES ('max729-audit-reader')");
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'max729-audit-reader'", [readerId]);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE r.name = 'max729-audit-reader' AND p.code IN ('audit:view', 'instance:view')`);
    await pool.query(`INSERT INTO database_instances (id, name, host, port, username, password_encrypted)
      VALUES (?, 'max729-fixture', 'fixture.invalid', 3306, 'test', 'test-only')`, [instanceId]);
    await pool.query("INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, 'read-only')", [readerId, instanceId]);
    await pool.query(`INSERT INTO agent_tool_audit (phase, actor_id, request_id, tool_name, allowed, reason_code,
      resource_json, policy_snapshot, args_redacted)
      VALUES ('decision', ?, 'shared-request', 'get_instance_summary', 1, 'ALLOW', '{}', '{}', '{}'),
             ('result', ?, 'shared-request', 'get_instance_summary', 1, 'ALLOW', '{}', '{}', '{}')`, [readerId, readerId]);
    const runner = new MigrationRunner(pool);
    const before = await runner.inspect();
    await runner.run();
    const after = await runner.inspect();
    expect(after).toEqual(expect.arrayContaining([
      ...before, expect.objectContaining({ migration_id: invocationMigration, status: 'completed' }),
    ]));
    await runner.run();
    expect(await runner.inspect()).toEqual(after);

    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    token = signAccessToken(await actorContextService.loadActiveActor(readerId), secret);
    app = Fastify();
    store = new DatabaseAuditLogStore(pool);
    const manager = new AuditLogManager(memory);
    manager.setPersistentStore(store);
    const verify = createVerifyToken(secret);
    await registerSystemAuditRoutes(app, verify, manager);
    await registerAgentSecurityRoutes(app, verify);
  }, 60_000);

  beforeAll(async () => {
    await loadPlatformTools();
  }, 15_000);

  afterAll(async () => {
    try {
      await app?.close();
      await pool?.end();
      if (created) await admin?.query(`DROP DATABASE ${database}`);
    } finally {
      await admin?.end();
      vi.restoreAllMocks();
    }
  });

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  it('applies exact category, result, and scope before pagination and count', async () => {
    const seed: Array<[string, string, Partial<AuditLogEntry>?]> = [
      ['register', 'POST /api/device/register'],
      ['challenge', 'POST /api/device/challenge', { result: 'success' }],
      ['preferences', 'PUT /api/user/preferences'],
      ['wrong-method', 'PATCH /api/user/preferences'],
      ['prefix', 'POST /api/device/register/extra'],
      ['case', 'POST /api/device/Register'],
      ['trailing-space', 'POST /api/device/challenge '],
      ['other-event', 'POST /api/device/register', { eventType: 'tool_call', result: 'pending' }],
      ['outside-time', 'PATCH /api/database/instances/:id', { timestamp: 100 }],
      ['other-resource', 'PATCH /api/database/instances/:id', { resourceId: '502' }],
    ];
    for (const [index, [id, action, overrides]] of seed.entries()) {
      const row: AuditLogEntry = {
        id, action, eventType: 'system_operation', level: 'warning', result: 'failure', timestamp: 1000 + index,
        resourceType: 'instance', resourceId: String(instanceId), username: 'max729-reader', ...overrides,
      };
      await store.write(row);
      await memory.write(row);
    }
    expect((await get('/api/audit/logs')).json().total).toBe(10);
    const background = await get('/api/audit/logs?requestCategory=background');
    expect(background.statusCode, background.body).toBe(200);
    expect(background.json().items.map((row: AuditLogEntry) => row.id)).toEqual(['preferences', 'challenge', 'register']);
    expect((await memory.query({ requestCategory: 'background' })).entries.map(row => row.id))
      .toEqual(background.json().items.map((row: AuditLogEntry) => row.id));
    expect((await get('/api/audit/logs?result=pending')).json()).toMatchObject({ total: 1, items: [{ id: 'other-event' }] });
    expect((await get('/api/audit/logs?eventType=tool_call&requestCategory=business')).json())
      .toMatchObject({ total: 1, items: [{ id: 'other-event' }] });
    expect((await get('/api/audit/logs?requestCategory=background&result=failure')).json())
      .toMatchObject({ total: 2, items: [{ id: 'preferences' }, { id: 'register' }] });
    const baseUrl = `/api/audit/logs?resource=instance:${instanceId}&requestCategory=business&result=failure&startTime=1970-01-01T00:00:01.000Z&keyword=max729&limit=2`;
    const page = await get(`${baseUrl}&offset=1`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({ total: 4, limit: 2, offset: 1, items: [{ id: 'case' }, { id: 'prefix' }] });
    expect((await memory.query({ resourceType: 'instance', resourceId: String(instanceId), requestCategory: 'business',
      result: 'failure', startTime: 1000, search: 'max729', limit: 2, offset: 1 })).entries.map(row => row.id)).toEqual(['case', 'prefix']);
    expect((await get('/api/audit/logs?requestCategory=background&result=pending')).json()).toMatchObject({ total: 0, items: [] });
    for (const query of ['result=unknown', 'requestCategory=', 'requestCategory=background&requestCategory=business']) {
      expect((await get(`/api/audit/logs?${query}`)).statusCode).toBe(400);
    }
    expect((await get('/api/audit/logs?resource=instance:502&result=failure')).statusCode).toBe(403);

    const original = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementationOnce(async filters => {
      const response = await original(filters);
      await pool.query('DELETE FROM instance_permissions WHERE user_id = ? AND instance_id = ?', [readerId, instanceId]);
      return response;
    });
    try {
      const revoked = await get(baseUrl);
      expect(revoked.statusCode).toBe(403);
      expect(revoked.json()).not.toHaveProperty('items');
      expect((await get(baseUrl)).statusCode).toBe(403);
    } finally {
      await pool.query("INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, 'read-only')", [readerId, instanceId]);
    }
  });

  it('links only exact invocation pairs, including exceptions, under the existing detail permission', async () => {
    const actor = await actorContextService.loadActiveActor(readerId, undefined, 'shared-request');
    const tool = (await getPlatformTool('get_instance_summary'))!;
    const [argumentSecret, resultSecret, handlerSecret] = Array.from({ length: 3 }, () => randomUUID());
    const handler = vi.spyOn(tool, 'handler').mockImplementation(async args => {
      if (args.label === 'exception') throw new Error(handlerSecret);
      return { success: true, data: { apiToken: resultSecret } };
    });
    try {
      const registry = createActorBoundToolRegistry(actor);
      const results = await Promise.all(['success', 'exception'].map(label =>
        registry.execute(tool.name, { instance_id: instanceId, label, password: argumentSecret })));
      expect(results).toMatchObject([{ success: true }, { success: false, errorCode: 'TOOL_EXECUTION_FAILED' }]);
      expect(await registry.execute(tool.name, { instance_id: 502, label: 'denied' }))
        .toMatchObject({ success: false, errorCode: 'INSTANCE_SCOPE_DENIED' });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      handler.mockRestore();
    }

    const [rows] = await pool.query<RowDataPacket[]>(`SELECT id, phase, invocation_id,
      JSON_UNQUOTE(JSON_EXTRACT(args_redacted, '$.label')) AS label FROM agent_tool_audit WHERE request_id = 'shared-request'`);
    expect(rows).toHaveLength(7);
    const details = (id: number) => get(`/api/agent/security/audit/${id}`);
    for (const label of ['success', 'exception']) {
      const decision = rows.find(row => row.label === label && row.phase === 'decision')!;
      const result = rows.find(row => row.label === label && row.phase === 'result')!;
      expect(decision.invocation_id).toBeTruthy();
      expect(result.invocation_id).toBe(decision.invocation_id);
      const forward = await details(decision.id);
      const backward = await details(result.id);
      expect(forward.statusCode, forward.body).toBe(200);
      expect(backward.statusCode, backward.body).toBe(200);
      expect(forward.json().record).toMatchObject({ relatedRecordId: result.id, args: { password: '[REDACTED]' } });
      expect(backward.json().record).toMatchObject({ relatedRecordId: decision.id, result: { success: label === 'success' } });
      expect(forward.json().record).not.toHaveProperty('invocation_id');
      const evidence = forward.body + backward.body;
      for (const original of [argumentSecret, resultSecret, handlerSecret]) expect(evidence).not.toContain(original);
    }
    expect(new Set(rows.filter(row => row.label === 'success' || row.label === 'exception').map(row => row.invocation_id)).size).toBe(2);
    for (const row of rows.filter(row => row.label === null || row.label === 'denied')) {
      expect((await details(row.id)).json().record).toMatchObject({ relatedRecordId: null });
    }
    const decision = rows.find(row => row.label === 'success' && row.phase === 'decision')!;
    await expect(pool.query(`INSERT INTO agent_tool_audit (phase, actor_id, request_id, tool_name, allowed, reason_code,
      resource_json, policy_snapshot, args_redacted, invocation_id)
      SELECT phase, actor_id, request_id, tool_name, allowed, reason_code,
        resource_json, policy_snapshot, args_redacted, invocation_id FROM agent_tool_audit WHERE id = ?`, [decision.id]))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await pool.query(`DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id WHERE r.name = 'max729-audit-reader' AND p.code = 'audit:view'`);
    expect((await details(decision.id)).statusCode).toBe(403);
    expect((await get('/api/audit/logs?requestCategory=background')).statusCode).toBe(403);
  });
});
