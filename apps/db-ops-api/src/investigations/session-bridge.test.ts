import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { AuthDatabaseService } from '../auth-database-service.js';
import { INVESTIGATION_SERVICE_PASSWORD } from '../auth/investigation-service-identity.js';
import { ChatDatabaseService } from '../chat-database-service.js';
import { InvestigationAuthorization, provisionInvestigationServiceIdentity, type AuthorityExecutor } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { registerInvestigationRoutes } from './routes.js';
import type { InvestigationRecord, InvestigationResource } from './store.js';

const port = Number(process.env.AUTH_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT);
describe.skipIf(!port)('T03-B real MySQL/JWT authorization and atomic Session bridge', () => {
  const database = `t03b_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  let admin: Pool;
  let pool: Pool;
  let contexts: ActorContextService;
  let authorization: InvestigationAuthorization;
  let bridge: InvestigationSessionBridge;
  let chat: ChatDatabaseService;
  let owner: ActorContext;
  let member: ActorContext;
  let service: ActorContext;
  let serviceId: number;
  let roleId: number;
  let app: FastifyInstance;
  let headers: { authorization: string };
  let investigation: InvestigationRecord;
  let blockedTool: string | undefined;
  const resources: InvestigationResource[] = [{ type: 'instance', id: 101, role: 'primary' },
    { type: 'server', id: 201, role: 'related' }, { type: 'network_device', id: 301, role: 'related' }];
  const create = () => ({ title: 'Protected latency', goal: 'Investigate read-only', profileId: 'ops' as const, profileVersion: 1, resources });
  const command = () => ({ investigationId: investigation.id, expectedVersion: investigation.version,
    idempotencyKey: 'request-key', message: 'Protected follow-up' });
  const all = async (table: string) => (await pool.query<RowDataPacket[]>(`SELECT * FROM ${table}`))[0];
  const actorOf = (request: FastifyRequest) => (request as FastifyRequest & { user: ActorContext }).user;
  const withConnection = async <T>(work: (c: AuthorityExecutor) => Promise<T>): Promise<T> => {
    const connection = await pool.getConnection();
    try { await connection.beginTransaction(); const result = await work(connection as unknown as AuthorityExecutor); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  };

  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', timezone: 'Z',
      password: process.env.AUTH_TEST_MYSQL_PASSWORD ?? process.env.REPORT_TEST_MYSQL_PASSWORD ?? '' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run();
    await pool.execute("INSERT INTO users (id, username, password_hash) VALUES (101, 't03-owner', 'not-a-login-hash'), (102, 't03-member', 'not-a-login-hash')");
    serviceId = await withConnection(c => provisionInvestigationServiceIdentity(c, 'ops-test'));
    const [role] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO roles (name) VALUES ('t03-diagnostic')");
    roleId = Number(role.insertId);
    await pool.execute(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions
      WHERE code IN ('chat:view','instance:view','metric:view','alert:view','servers:view','network_devices:view','config:view')`, [roleId]);
    await pool.execute("INSERT INTO database_instances (id, name, host, port, username, password_encrypted) VALUES (101, 'test-instance', 'fixture.invalid', 3306, 'fixture', 'unused'), (103, 'outside-instance', 'other.invalid', 3306, 'fixture', 'unused')");
    await pool.execute("INSERT INTO servers (id, label, host, os_type, credential_type, credential_encrypted) VALUES (201, 'test-server', 'server.invalid', 'Other', 'password', 'unused')");
    await pool.execute("INSERT INTO network_devices (id, name, host) VALUES (301, 'test-network', 'network.invalid')");
    contexts = new ActorContextService(() => pool as unknown as ReturnType<NonNullable<ConstructorParameters<typeof ActorContextService>[0]>>);
    authorization = new InvestigationAuthorization(contexts, name => name !== blockedTool);
    bridge = new InvestigationSessionBridge(() => pool, authorization);
    chat = new ChatDatabaseService(() => pool, authorization);
    app = Fastify();
    app.addHook('preHandler', createVerifyToken(secret, contexts));
    // Retain bridge fixtures and exercise the merged T02-C production routes.
    await registerInvestigationRoutes(app, createVerifyToken(secret, contexts), bridge);
    app.get('/fixture/list', request => bridge.storeFor(actorOf(request)).list({ kind: 'user', id: actorOf(request).userId }, { limit: 1 }));
    app.get('/fixture/messages/:id', request => bridge.messages(actorOf(request), (request.params as { id: string }).id));
    app.get('/fixture/detail/:id', request => bridge.storeFor(actorOf(request)).detail({ kind: 'user', id: actorOf(request).userId }, (request.params as { id: string }).id));
    app.post('/fixture/continue/:id', request => bridge.admit(actorOf(request), { ...command(), investigationId: (request.params as { id: string }).id }));
    app.post('/fixture/cancel/:id', request => withConnection(async c => {
      const target = await authorization.load(c, (request.params as { id: string }).id);
      await authorization.authorize(c, actorOf(request), target, 'cancel'); return { authorized: true };
    }));
    await app.ready();
  }, 120_000);

  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS inject_bridge_failure');
    for (const table of ['investigation_admission_keys', 'investigation_requests', 'investigation_members', 'investigation_resources', 'investigations',
      'chat_session_shares', 'chat_messages', 'chat_sessions', 'workflow_jobs', 'outbox_events', 'agent_runs', 'refresh_tokens']) await pool.query(`DELETE FROM ${table}`);
    await pool.execute("UPDATE users SET status = 'active', session_version = 1 WHERE id IN (101, 102, ?)", [serviceId]);
    await pool.execute("UPDATE users SET username = 'slide-investigation-ops-test', password_hash = ? WHERE id = ?", [INVESTIGATION_SERVICE_PASSWORD, serviceId]);
    await pool.execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code IN (\'chat:view\',\'instance:view\',\'metric:view\',\'alert:view\',\'servers:view\',\'network_devices:view\',\'config:view\')', [roleId]);
    await pool.execute('DELETE FROM user_roles WHERE user_id IN (101, 102, ?)', [serviceId]);
    await pool.execute('DELETE FROM instance_permissions WHERE user_id IN (101, 102, ?)', [serviceId]);
    for (const id of [101, 102, serviceId]) {
      await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId]);
      await pool.execute("INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, 101, 'read-only'), (?, 103, 'read-only')", [id, id]);
    }
    blockedTool = undefined;
    owner = await contexts.loadActiveActor(101);
    member = await contexts.loadActiveActor(102);
    service = { ...await withConnection(c => contexts.loadInvestigationActorFrom(c, serviceId, 'service', 1)),
      resourceBoundary: { instanceIds: [101], serverIds: [201], networkDeviceIds: [301] } };
    investigation = (await bridge.create(owner, create())).investigation;
    headers = { authorization: `Bearer ${signAccessToken(owner, secret)}` };
  });

  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  it('100 same-key admissions append one message, one request/job/outbox and stable acceptance', async () => {
    const accepted = await Promise.all(Array.from({ length: 100 }, () => bridge.admit(owner, command())));
    expect(new Set(accepted.map(value => JSON.stringify(value))).size).toBe(1);
    for (const table of ['chat_messages', 'investigation_requests', 'workflow_jobs', 'outbox_events']) expect(await all(table)).toHaveLength(1);
    const message = (await all('chat_messages'))[0];
    const request = (await all('investigation_requests'))[0];
    expect(request.message_id).toBe(message.message_id);
    expect((await all('chat_sessions'))[0].message_count).toBe(1);
    expect(request.request_snapshot.authority).toMatchObject({ actor: { id: 101, kind: 'user' }, profileId: 'ops', schemaVersion: 1 });
    expect(request.request_snapshot.authority.permissions).not.toContain('*');
  });

  it.each(['chat_messages', 'request-binding', 'session-stats'])('failure at %s rolls back message/admission/job/version/key', async point => {
    const table = point === 'chat_messages' ? 'chat_messages' : point === 'request-binding' ? 'investigation_requests' : 'chat_sessions';
    await pool.query(`CREATE TRIGGER inject_bridge_failure BEFORE ${point === 'chat_messages' ? 'INSERT' : 'UPDATE'} ON ${table}
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_BRIDGE_FAILURE'`);
    await expect(bridge.admit(owner, command())).rejects.toMatchObject({ statusCode: 503 });
    for (const name of ['chat_messages', 'investigation_requests', 'workflow_jobs', 'outbox_events', 'investigation_admission_keys']) expect(await all(name)).toHaveLength(0);
    expect((await all('investigations'))[0]).toMatchObject({ version: 1, active_request_id: null });
    await pool.query('DROP TRIGGER inject_bridge_failure');
    await expect(bridge.admit(owner, command())).resolves.toMatchObject({ version: 2 });
  });

  it('create plus first admission fails atomically with no new Session or investigation', async () => {
    await pool.query("CREATE TRIGGER inject_bridge_failure BEFORE INSERT ON chat_messages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'FAIL'");
    await expect(bridge.create(owner, create(), { message: 'First', idempotencyKey: 'first' })).rejects.toMatchObject({ statusCode: 503 });
    expect(await all('investigations')).toHaveLength(1); expect(await all('chat_sessions')).toHaveLength(1);
    for (const table of ['chat_messages', 'investigation_requests', 'workflow_jobs', 'outbox_events']) expect(await all(table)).toHaveLength(0);
  });

  it('owner conversion preserves Session/message IDs; read share cannot convert or append', async () => {
    const original = await chat.createSession(owner);
    await chat.addMessage(owner, original.session_id, { messageId: 'original-id', role: 'user', content: 'Original' });
    await chat.grantSessionShare(owner, original.session_id, 102, 'read');
    expect(await chat.getMessages(member, original.session_id)).toHaveLength(1);
    await expect(bridge.create(member, { ...create(), sessionId: original.session_id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(chat.addMessage(member, original.session_id, { messageId: 'unauthorized', role: 'user', content: 'no' })).rejects.toThrow('Chat session not found');
    const converted = await bridge.create(owner, { ...create(), sessionId: original.session_id });
    expect(converted.investigation.sessionId).toBe(original.session_id);
    expect((await all('chat_messages')).map(row => row.message_id)).toEqual(['original-id']);
    await expect(chat.getMessages(member, original.session_id)).rejects.toThrow('Chat session not found');
    await expect(chat.addMessage(owner, original.session_id, { messageId: 'bypass', role: 'user', content: 'no' })).rejects.toThrow('Chat session not found');
  });

  it('active Chat Run prevents conversion without changing history', async () => {
    const original = await chat.createSession(owner);
    await pool.execute("INSERT INTO agent_runs (id, actor_id, session_id, message_id, idempotency_key, state, expires_at) VALUES (?, 101, ?, 'm', 'k', 'running', DATE_ADD(NOW(), INTERVAL 1 DAY))", [randomUUID(), original.session_id]);
    await expect(bridge.create(owner, { ...create(), sessionId: original.session_id })).rejects.toMatchObject({ statusCode: 409 });
    expect(await all('investigations')).toHaveLength(1);
  });

  it('viewer has read access but cannot continue/cancel; operator continuation keeps service ownership', async () => {
    const automatic = (await bridge.create(service, create())).investigation;
    await pool.execute("INSERT INTO investigation_members (investigation_id, user_id, role, granted_by) VALUES (?, 102, 'viewer', ?)", [automatic.id, serviceId]);
    const viewerHeaders = { authorization: `Bearer ${signAccessToken(member, secret)}` };
    expect((await app.inject({ url: `/fixture/detail/${automatic.id}`, headers: viewerHeaders })).statusCode).toBe(200);
    for (const action of ['continue', 'cancel']) expect((await app.inject({ method: 'POST', url: `/fixture/${action}/${automatic.id}`, headers: viewerHeaders })).statusCode).toBe(403);
    await pool.execute("UPDATE investigation_members SET role = 'operator' WHERE investigation_id = ?", [automatic.id]);
    await bridge.admit(member, { ...command(), investigationId: automatic.id });
    expect((await all('chat_sessions')).find(row => row.session_id === automatic.sessionId)?.user_id).toBe(serviceId);
    expect((await all('investigation_requests'))[0]).toMatchObject({ actor_id: 102, actor_kind: 'user' });
    await pool.execute('UPDATE investigation_members SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE investigation_id = ?', [automatic.id]);
    await expect(bridge.messages(member, automatic.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(['delete', 'expire'] as const)('same JWT after instance grant %s hides title/messages/counts and denies idempotent retry', async mode => {
    const cmd = command(); await bridge.admit(owner, cmd);
    expect((await app.inject({ url: `/fixture/messages/${investigation.id}`, headers })).json()).toHaveLength(1);
    if (mode === 'delete') await pool.execute('DELETE FROM instance_permissions WHERE user_id = 101 AND instance_id = 101');
    else await pool.execute('UPDATE instance_permissions SET grant_expiry = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id = 101 AND instance_id = 101');
    const list = await app.inject({ url: '/fixture/list', headers }); expect(list.json()).toEqual({ items: [], total: 0 });
    for (const view of ['detail', 'messages']) {
      const result = await app.inject({ url: `/fixture/${view}/${investigation.id}`, headers });
      expect(result.statusCode).toBe(404); expect(result.body).not.toContain('Protected');
    }
    await expect(bridge.admit(owner, cmd)).rejects.toMatchObject({ statusCode: 404 });
    for (const call of [() => chat.getMessages(owner, investigation.sessionId), () => chat.getSessionCount(owner, investigation.sessionId),
      () => chat.authorizeSession(owner, investigation.sessionId, 'watch')]) await expect(call()).rejects.toThrow('Chat session not found');
    expect(await chat.getSessions(owner)).toHaveLength(0); expect(await all('chat_messages')).toHaveLength(1);
  });

  it.each(['instance', 'server', 'network_device'] as const)('missing any required %s caller ceiling hides the entire investigation', async type => {
    const bounded: ActorContext = { ...owner, resourceBoundary: { instanceIds: type === 'instance' ? [] : [101],
      serverIds: type === 'server' ? [] : [201], networkDeviceIds: type === 'network_device' ? [] : [301] } };
    await expect(bridge.storeFor(bounded).detail({ kind: 'user', id: 101 }, investigation.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(bridge.storeFor(bounded).list({ kind: 'user', id: 101 })).resolves.toEqual({ items: [], total: 0 });
    await expect(bridge.messages(bounded, investigation.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(['instance:view', 'servers:view', 'network_devices:view'])('live revoke of %s hides multi-resource content, count and watch authority', async code => {
    await pool.execute('DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? AND p.code = ?', [roleId, code]);
    const result = await app.inject({ url: '/fixture/list', headers });
    expect(result.json()).toEqual({ items: [], total: 0 });
    await expect(bridge.messages(owner, investigation.id)).rejects.toMatchObject({ statusCode: 404 });
    await withConnection(async c => {
      const target = await authorization.load(c, investigation.id);
      await expect(authorization.authorize(c, owner, target, 'watch')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('another admin with no investigation membership cannot read a service Session', async () => {
    const automatic = (await bridge.create(service, create())).investigation;
    const [adminRole] = (await pool.query<RowDataPacket[]>("SELECT id FROM roles WHERE name = 'admin'"))[0];
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (102, ?)', [adminRole.id]);
    const elevated = await contexts.loadActiveActor(102);
    expect(elevated.permissions).toContain('*');
    await expect(bridge.messages(elevated, automatic.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('frozen tools and resource ceilings cannot expand after admin promotion; live tool policy can shrink', async () => {
    // Retain a caller with query_metrics deliberately absent before admission.
    const limited = { ...owner, permissions: owner.permissions.filter(code => code !== 'metric:view') };
    const accepted = await bridge.admit(limited, command());
    const frozen = await bridge.requestAuthority(limited, investigation.id, accepted.requestId);
    expect(frozen.toolAllowlist).not.toContain('query_metrics');
    const [adminRole] = (await pool.query<RowDataPacket[]>("SELECT id FROM roles WHERE name = 'admin'"))[0];
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (101, ?)', [adminRole.id]);
    const promoted = await contexts.loadActiveActor(101);
    await withConnection(async c => {
      const current = await authorization.load(c, investigation.id);
      await expect(authorization.authorizeTool(c, promoted, current, frozen, 'query_metrics', [{ type: 'instance', id: 101 }])).rejects.toMatchObject({ statusCode: 403 });
      await expect(authorization.authorizeTool(c, promoted, current, frozen, 'execute_code', [])).rejects.toMatchObject({ statusCode: 403 });
      await expect(authorization.authorizeTool(c, promoted, current, frozen, 'get_instance_summary', [{ type: 'instance', id: 103 }])).rejects.toMatchObject({ statusCode: 404 });
      expect((await authorization.authorizeTool(c, promoted, current, frozen, 'get_instance_summary', [{ type: 'instance', id: 101 }])).actor.roles).toEqual([]);
      blockedTool = 'get_instance_summary';
      await expect(authorization.authorizeTool(c, promoted, current, frozen, 'get_instance_summary', [{ type: 'instance', id: 101 }])).rejects.toMatchObject({ statusCode: 403 });
    });
    await pool.execute('DELETE FROM instance_permissions WHERE user_id = 101 AND instance_id = 101');
    await expect(bridge.requestAuthority(promoted, investigation.id, accepted.requestId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('service cannot login via forged JWT/refresh or inherit admin and wildcard grants', async () => {
    const signed = jwt.sign({ userId: serviceId, sessionVersion: 1 }, secret);
    expect((await app.inject({ url: '/fixture/list', headers: { authorization: `Bearer ${signed}` } })).statusCode).toBe(401);
    await expect(contexts.loadActiveActor(serviceId)).rejects.toThrow('Authentication failed');
    await expect(contexts.issueRefreshToken(service)).rejects.toThrow('Authentication failed');
    const refresh = 'test-only-refresh';
    const { createHash } = await import('node:crypto');
    await pool.execute('INSERT INTO refresh_tokens (token_hash, user_id, session_version, expires_at) VALUES (?, ?, 1, DATE_ADD(NOW(), INTERVAL 1 DAY))', [createHash('sha256').update(refresh).digest('hex'), serviceId]);
    await expect(contexts.rotateRefreshToken(refresh)).rejects.toThrow('Authentication failed');
    const [adminRole] = (await pool.query<RowDataPacket[]>("SELECT id FROM roles WHERE name = 'admin'"))[0];
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [serviceId, adminRole.id]);
    await expect(bridge.create(service, create())).rejects.toMatchObject({ statusCode: 404 });
  });

  it('password login remains disabled even if a service is accidentally given a valid bcrypt password or renamed', async () => {
    const password = randomUUID();
    const auth = new AuthDatabaseService(() => pool);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 4), serviceId]);
    expect(await auth.verifyPassword('slide-investigation-ops-test', password)).toBe(false);
    await expect(contexts.loadActiveActor(serviceId)).rejects.toThrow('Authentication failed');
    await pool.execute("UPDATE users SET username = 'renamed-service', password_hash = ? WHERE id = ?", [INVESTIGATION_SERVICE_PASSWORD, serviceId]);
    expect(await auth.verifyPassword('renamed-service', password)).toBe(false);
    await expect(contexts.loadActiveActor(serviceId)).rejects.toThrow('Authentication failed');
  });

  it.each(['inactive', 'sessionVersion', 'role-expiry'] as const)('same JWT and retained actor fail closed after %s', async mode => {
    if (mode === 'inactive') await pool.execute("UPDATE users SET status = 'inactive' WHERE id = 101");
    else if (mode === 'sessionVersion') await pool.execute('UPDATE users SET session_version = 2 WHERE id = 101');
    else await pool.execute('UPDATE user_roles SET grant_expiry = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id = 101');
    const response = await app.inject({ url: `/fixture/messages/${investigation.id}`, headers });
    expect(response.statusCode).toBe(mode === 'role-expiry' ? 404 : 401);
    await expect(bridge.messages(owner, investigation.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('system Profile requires config scope and hides content with extra inaccessible evidence scope', async () => {
    const system = (await bridge.create(owner, { ...create(), profileId: 'system', resources: [] })).investigation;
    await withConnection(async c => {
      const authority = await authorization.authorize(c, owner, system, 'watch');
      expect(authority.tools).toContain('get_platform_observations');
      expect(authority.tools).not.toContain('get_instance_summary');
      await expect(authorization.authorize(c, { ...owner, resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } },
        system, 'content', [{ type: 'instance', id: 101 }])).rejects.toMatchObject({ statusCode: 404 });
      await expect(authorization.authorize(c, { ...owner, permissions: owner.permissions.filter(code => code !== 'config:view') }, system, 'read')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it.each(['member-delete', 'member-expire', 'role-permission', 'role-expire'] as const)(
    'production HTTP and retained consumer authority hide content after %s with the same JWT', async mode => {
      await pool.execute("INSERT INTO investigation_members (investigation_id, user_id, role, granted_by) VALUES (?, 102, 'operator', 101)", [investigation.id]);
      const cmd = { ...command(), idempotencyKey: 'member-request' };
      const accepted = await bridge.admit(member, cmd);
      const frozen = await bridge.requestAuthority(member, investigation.id, accepted.requestId);
      const auth = { authorization: `Bearer ${signAccessToken(member, secret)}` };
      const base = `/api/investigations/${investigation.id}`;
      expect((await app.inject({ url: `${base}/messages`, headers: auth })).json().messages).toHaveLength(1);
      if (mode === 'member-delete') await pool.execute('DELETE FROM investigation_members WHERE investigation_id = ? AND user_id = 102', [investigation.id]);
      else if (mode === 'member-expire') await pool.execute('UPDATE investigation_members SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE investigation_id = ?', [investigation.id]);
      else if (mode === 'role-permission') await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? AND p.code = 'chat:view'", [roleId]);
      else await pool.execute('UPDATE user_roles SET grant_expiry = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id = 102');

      for (const url of [base, `${base}/messages`]) {
        const response = await app.inject({ url, headers: auth });
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain('Protected');
        expect(response.headers['cache-control']).toContain('no-store');
      }
      const list = await app.inject({ url: '/api/investigations?limit=1', headers: auth });
      expect(list.json()).toMatchObject({ items: [], authorizedCounts: { total: 0 }, nextCursor: null });
      expect((await app.inject({ method: 'POST', url: `${base}/runs`, headers: { ...auth, 'idempotency-key': cmd.idempotencyKey },
        payload: { expectedVersion: cmd.expectedVersion, message: cmd.message } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `${base}/requests/${accepted.requestId}/cancel`, headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PATCH', url: base, headers: auth, payload: { expectedVersion: accepted.version, title: 'no' } })).statusCode).toBe(404);
      await expect(bridge.requestAuthority(member, investigation.id, accepted.requestId)).rejects.toMatchObject({ statusCode: 404 });
      await withConnection(async c => {
        const current = await authorization.load(c, investigation.id);
        await expect(authorization.authorize(c, member, current, 'watch')).rejects.toMatchObject({ statusCode: 404 });
        await expect(authorization.authorizeTool(c, member, current, frozen, 'get_instance_summary', [{ type: 'instance', id: 101 }]))
          .rejects.toMatchObject({ statusCode: 404 });
      });
      for (const call of [() => chat.getMessages(member, investigation.sessionId), () => chat.getSessionCount(member, investigation.sessionId),
        () => chat.authorizeSession(member, investigation.sessionId, 'watch')]) await expect(call()).rejects.toThrow('Chat session not found');
      for (const table of ['chat_messages', 'investigation_requests', 'workflow_jobs', 'outbox_events']) expect(await all(table)).toHaveLength(1);
    });

  it('operator downgrade preserves reads but revokes retry, cancel, patch and retained tool authority', async () => {
    await pool.execute("INSERT INTO investigation_members (investigation_id, user_id, role, granted_by) VALUES (?, 102, 'operator', 101)", [investigation.id]);
    const cmd = { ...command(), idempotencyKey: 'operator-request' };
    const accepted = await bridge.admit(member, cmd);
    const frozen = await bridge.requestAuthority(member, investigation.id, accepted.requestId);
    const auth = { authorization: `Bearer ${signAccessToken(member, secret)}` };
    await pool.execute("UPDATE investigation_members SET role = 'viewer' WHERE investigation_id = ?", [investigation.id]);
    const base = `/api/investigations/${investigation.id}`;
    expect((await app.inject({ url: `${base}/messages`, headers: auth })).json().messages).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: `${base}/runs`, headers: { ...auth, 'idempotency-key': cmd.idempotencyKey },
      payload: { expectedVersion: cmd.expectedVersion, message: cmd.message } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${base}/requests/${accepted.requestId}/cancel`, headers: auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: base, headers: auth, payload: { expectedVersion: accepted.version, title: 'no' } })).statusCode).toBe(403);
    await withConnection(async c => {
      const current = await authorization.load(c, investigation.id);
      await expect(authorization.authorize(c, member, current, 'watch')).resolves.toBeDefined();
      await expect(authorization.authorizeTool(c, member, current, frozen, 'get_instance_summary', [{ type: 'instance', id: 101 }]))
        .rejects.toMatchObject({ statusCode: 403 });
    });
    for (const table of ['chat_messages', 'investigation_requests', 'workflow_jobs', 'outbox_events']) expect(await all(table)).toHaveLength(1);
  });

  it.each(['profileHash', 'scopeVersion', 'sessionId', 'sessionVersion'] as const)(
    'reopening the bridge rejects persisted authority with stale %s', async field => {
      const accepted = await bridge.admit(owner, command());
      const request = (await all('investigation_requests'))[0];
      const snapshot = request.request_snapshot;
      snapshot.authority[field] = field === 'sessionVersion' ? 999 : 'stale';
      await pool.execute('UPDATE investigation_requests SET request_snapshot = ? WHERE id = ?', [JSON.stringify(snapshot), accepted.requestId]);
      const reopened = new InvestigationSessionBridge(() => pool, authorization);
      await expect(reopened.requestAuthority(owner, investigation.id, accepted.requestId)).rejects.toMatchObject({ statusCode: 404 });
      // Content readers have their own live ACL; they cannot inherit execution authority.
      await expect(reopened.messages(owner, investigation.id)).resolves.toHaveLength(1);
    });

  it('another operator can read service history but cannot inherit the admitted user authority', async () => {
    const automatic = (await bridge.create(service, create())).investigation;
    await pool.execute("INSERT INTO investigation_members (investigation_id, user_id, role, granted_by) VALUES (?, 101, 'operator', ?), (?, 102, 'operator', ?)",
      [automatic.id, serviceId, automatic.id, serviceId]);
    const accepted = await bridge.admit(member, { ...command(), investigationId: automatic.id });
    const reopened = new InvestigationSessionBridge(() => pool, authorization);
    await expect(reopened.messages(owner, automatic.id)).resolves.toHaveLength(1);
    await expect(reopened.requestAuthority(owner, automatic.id, accepted.requestId)).rejects.toMatchObject({ statusCode: 404 });
    const snapshot = await reopened.requestAuthority(member, automatic.id, accepted.requestId);
    expect(snapshot.actor).toEqual({ kind: 'user', id: 102 });
    expect(Object.isFrozen(snapshot.resourceBoundary.instanceIds)).toBe(true);
    expect((await all('chat_sessions')).find(row => row.session_id === automatic.sessionId)?.user_id).toBe(serviceId);
  });
});
