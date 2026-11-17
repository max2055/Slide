import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerChatRoutes } from '../chat-routes.js';
import { dbConnection } from '../db-connection.js';
import { registerHttpSecurity } from '../security/http-security.js';
import { registerCronRoutes } from './cron-routes.js';
import { actorContextService } from '../auth/actor-context.js';

it('MAX-684 returns exact job lists over a socket with instance scopes and owner fields', async () => {
  const app = Fastify();
  const rows = [
    { id: 41, name: 'owned', owner_user_id: 7, target_instance_id: 11, enabled: 1 },
    { id: 42, name: 'other owner', owner_user_id: 8, target_instance_id: 12, enabled: 0 },
    { id: 43, name: 'platform', owner_user_id: 7, target_instance_id: null, enabled: 0 },
  ];
  // Real service query and Boolean mapping; controlled SQL transport and identity.
  const execute = vi.fn(async (sql: string, params: number[]) => {
    expect(sql).toContain('FROM cron_jobs');
    expect(sql).toContain('ORDER BY name');
    if (sql.includes('WHERE 1 = 0')) return [[], []];
    if (sql.includes('WHERE target_instance_id IN')) {
      return [rows.filter(row => params.includes(row.target_instance_id!)), []];
    }
    return [rows, []];
  });
  const pool = vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  let actor: any = { userId: 7, roles: ['admin'], permissions: ['*'] };
  const verifyToken = async (request: any) => { request.user = actor; };
  const authorizeChat = vi.fn();
  const handleChatSend = vi.fn();
  try {
    app.addHook('onSend', async (_request, _reply, payload) => payload);
    await registerHttpSecurity(app);
    await registerChatRoutes(app, { verifyToken, service: {} as any, authorizeChat, handleChatSend });
    registerCronRoutes(app, verifyToken, () => undefined);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const cases = [
      { actor, ids: [41, 42, 43], params: [] },
      { actor: { userId: 7, roles: [], permissions: ['cron:view'], instanceScopes: { 12: 'read-only' } }, ids: [42], params: [12] },
      { actor: { userId: 7, roles: [], permissions: ['cron:view'], instanceScopes: {} }, ids: [], params: [] },
      { actor: { userId: 7, roles: ['admin'], permissions: ['*'], resourceBoundary: { instanceIds: [11] } }, ids: [41], params: [11] },
    ];
    for (const scenario of cases) {
      actor = scenario.actor;
      const response = await fetch(`${address}/api/cron/jobs`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(Buffer.byteLength(body)).toBeGreaterThan(0);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(JSON.parse(body)).toEqual(rows.filter(row => scenario.ids.includes(row.id))
        .map(row => ({ ...row, enabled: Boolean(row.enabled) })));
      expect(execute.mock.calls.at(-1)?.[1]).toEqual(scenario.params);
    }
    // Preserve instance-based listing: an accessible other-owner job is visible.
    expect(execute).toHaveBeenCalledTimes(cases.length);
    expect(authorizeChat).not.toHaveBeenCalled();
    expect(handleChatSend).not.toHaveBeenCalled();
  } finally {
    await app.close();
    pool.mockRestore();
  }
});

it('MAX-684 returns the created script JSON over a socket with production async hooks', async () => {
  const app = Fastify();
  // Keep ScriptService and the INSERT path real; only the SQL transport is controlled.
  // Real MySQL persistence is additionally covered by the isolated browser acceptance.
  const execute = vi.fn(async () => [{ insertId: 37 }, []]);
  const pool = vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  const verifyToken = async (request: any) => {
    request.user = { userId: 7, roles: ['admin'], permissions: ['*'] };
  };
  const authorizeChat = vi.fn();
  const handleChatSend = vi.fn();
  try {
    app.addHook('onSend', async (_request, _reply, payload) => payload);
    await registerHttpSecurity(app);
    await registerChatRoutes(app, { verifyToken, service: {} as any, authorizeChat, handleChatSend });
    registerCronRoutes(app, verifyToken, () => undefined);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/cron/scripts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'socket regression', content: 'SELECT 7 AS qualified_value', target_db_type: 'mysql' }),
    });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeGreaterThan(0);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(body)).toEqual({ id: 37, message: '创建成功' });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      'INSERT INTO cron_scripts (name, description, script_type, content, target_db_type) VALUES (?, ?, ?, ?, ?)',
      ['socket regression', null, 'sql', 'SELECT 7 AS qualified_value', 'mysql'],
    );
    expect(authorizeChat).not.toHaveBeenCalled();
    expect(handleChatSend).not.toHaveBeenCalled();
  } finally {
    await app.close();
    pool.mockRestore();
  }
});

it('MAX-684 returns the created job JSON over a socket with production async hooks', async () => {
  const app = Fastify();
  const actor = { userId: 7, username: 'socket-admin', roles: ['admin'], permissions: ['*'],
    sessionVersion: 1, instanceScopes: {}, requestId: 'socket-job' };
  // Keep identity binding, CronJobDatabaseService and INSERT real; control identity
  // lookup and SQL transport. Real JWT/MySQL is verified separately.
  const loadActor = vi.spyOn(actorContextService, 'loadActiveActor').mockResolvedValue(actor);
  const execute = vi.fn(async (sql: string) => {
    if (sql === 'SELECT id FROM database_instances') return [[], []];
    if (sql.startsWith('INSERT INTO cron_jobs ')) return [{ insertId: 41 }, []];
    throw new Error('UNEXPECTED_SQL');
  });
  const pool = vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  const verifyToken = async (request: any) => { request.user = actor; };
  const authorizeChat = vi.fn();
  const handleChatSend = vi.fn();
  const reload = vi.fn(async () => {});
  try {
    app.addHook('onSend', async (_request, _reply, payload) => payload);
    await registerHttpSecurity(app);
    await registerChatRoutes(app, { verifyToken, service: {} as any, authorizeChat, handleChatSend });
    registerCronRoutes(app, verifyToken, () => ({ reload } as any));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/cron/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'socket job regression', task_description: 'isolated qualification',
        cron_expr: '0 0 1 1 *', target_instance_id: null }),
    });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeGreaterThan(0);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(body)).toEqual({ id: 41, message: '创建成功' });
    expect(loadActor).toHaveBeenCalledExactlyOnceWith(7);
    expect(execute).toHaveBeenCalledTimes(2);
    const [sql, values] = execute.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ')).toBe("INSERT INTO cron_jobs (name, task_description, cron_expr, task_type, script_id, script_binding, target_instance_id, timezone, description, timeout_seconds, owner_user_id, principal_type, resource_scope, identity_status, identity_audit, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)");
    expect(values.slice(0, 11)).toEqual(['socket job regression', 'isolated qualification', '0 0 1 1 *',
      'agent', null, null, null, 'Asia/Shanghai', null, 300, 7]);
    expect(JSON.parse(values[11] as string)).toEqual({ version: 1, targetInstanceId: null,
      instanceIds: [], serverIds: [], networkDeviceIds: [] });
    expect(values[12]).toBe('bound');
    expect(JSON.parse(values[13] as string)).toEqual({ bound_by: 7, owner_user_id: 7,
      bound_at: expect.any(String), source: 'authenticated-route' });
    expect(values[14]).toBe(1);
    expect(reload).toHaveBeenCalledExactlyOnceWith();
    expect(authorizeChat).not.toHaveBeenCalled();
    expect(handleChatSend).not.toHaveBeenCalled();
  } finally {
    await app.close();
    pool.mockRestore();
    loadActor.mockRestore();
  }
});
