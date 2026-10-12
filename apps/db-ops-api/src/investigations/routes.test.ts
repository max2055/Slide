import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { registerInvestigationRoutes } from './routes.js';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { INVESTIGATION_SERVICE_PASSWORD } from '../auth/investigation-service-identity.js';
import { ChatDatabaseService } from '../chat-database-service.js';
import { InvestigationAuthorization, provisionInvestigationServiceIdentity, type AuthorityExecutor } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import type { InvestigationRecord, InvestigationResource } from './store.js';

const port = Number(process.env.AUTH_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT);
describe.skipIf(!port)('T02-C real investigation HTTP/JWT/MySQL', () => {
  const database = `t02c_${process.pid}_${randomUUID().replaceAll('-', '')}`;
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
  let address: string;
  let blockedTool: string | undefined;
  const resources: InvestigationResource[] = [{ type: 'instance', id: 101, role: 'primary' },
    { type: 'server', id: 201, role: 'related' }, { type: 'network_device', id: 301, role: 'related' }];
  const create = () => ({ title: 'Protected latency', goal: 'Investigate read-only', profileId: 'ops' as const, profileVersion: 1, resources });
  const payload = () => ({ title: 'Protected latency', goal: 'Investigate read-only', profileId: 'ops',
    subject: { kind: 'resource', resource: { type: 'instance', id: 101 } }, resourceRefs: resources });
  const post = (key = 'create-key', body = payload(), auth = headers) => app.inject({ method: 'POST', url: '/api/investigations', headers: { ...auth, 'idempotency-key': key }, payload: body });
  const runs = (id: string, key: string, expectedVersion = 2, message = 'Follow-up', auth = headers) => app.inject({ method: 'POST', url: `/api/investigations/${id}/runs`, headers: { ...auth, 'idempotency-key': key }, payload: { expectedVersion, message } });
  const idle = async (id: string) => {
    const [requests] = await pool.execute<RowDataPacket[]>('SELECT job_id FROM investigation_requests WHERE investigation_id = ?', [id]);
    for (const request of requests) await pool.execute("UPDATE workflow_jobs SET state = 'completed' WHERE id = ?", [request.job_id]);
    await pool.execute('UPDATE investigations SET active_request_id = NULL WHERE id = ?', [id]);
  };
  const all = async (table: string) => (await pool.query<RowDataPacket[]>(`SELECT * FROM ${table}`))[0];
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
    await registerInvestigationRoutes(app, createVerifyToken(secret, contexts), bridge);
    address = await app.listen({ host: '127.0.0.1', port: 0 });
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
    headers = { authorization: `Bearer ${signAccessToken(owner, secret)}` };
  });

  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  it('real TCP HTTP preserves CRUD/context after reopening the database connection and migration rerun', async () => {
    const command = { ...payload(), from: '2026-10-12T01:00:00Z', to: '2026-10-12T01:30:00Z' };
    const response = await fetch(`${address}/api/investigations`, { method: 'POST', headers: { ...headers, 'content-type':'application/json', 'idempotency-key':'tcp-key' }, body: JSON.stringify(command) });
    expect(response.status).toBe(202); const accepted = await response.json() as { id: string; requestId: string };
    await new MigrationRunner(pool).run();
    const ledger=(await pool.query<RowDataPacket[]>("SELECT status FROM app_schema_migrations WHERE migration_id='113_investigation_create_keys.sql'"))[0];
    expect(ledger).toEqual([expect.objectContaining({status:'completed'})]);
    const patch=await fetch(`${address}/api/investigations/${accepted.id}`,{method:'PATCH',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({expectedVersion:2,title:'TCP updated'})});
    expect(patch.status).toBe(200);
    const detail=await fetch(`${address}/api/investigations/${accepted.id}`,{headers}); expect(detail.headers.get('cache-control')).toContain('no-store');
    const record=await detail.json() as InvestigationRecord; expect(record).toMatchObject({ title:'TCP updated',version:3,context:{subject:command.subject,from:command.from,to:command.to},derivedRunState:null,latestResult:null });
    expect((await all('investigation_requests'))[0].request_snapshot.context).toEqual(record.context);
    const replay=await post('tcp-key',command as never); expect(replay.statusCode).toBe(202); expect(replay.json()).toEqual(accepted);
    const query=await fetch(`${address}/api/investigations?query=TCP`,{headers}); expect((await query.json() as { authorizedCounts: { total: number } }).authorizedCounts.total).toBe(1);
    const connection=await pool.getConnection(); try { const [rows]=await connection.execute<RowDataPacket[]>('SELECT title FROM investigations WHERE id=?',[accepted.id]); expect(rows[0].title).toBe('TCP updated'); } finally { connection.release(); }
  });

  it('create retry and original request retry share the actor/key-first lock order', async () => {
    const accepted=(await post()).json();
    const responses=await Promise.all(Array.from({length:100},(_,i)=>i%2?post():runs(accepted.id,'create-key',1,payload().goal)));
    expect(responses.map(r=>r.statusCode)).toEqual(Array(100).fill(202));
    expect(new Set(responses.map(r=>r.body)).size).toBe(1);
    expect(await all('investigation_requests')).toHaveLength(1); expect(await all('chat_messages')).toHaveLength(1);
  });

  it.each(['investigation_requests','chat_messages','workflow_jobs','outbox_events'])('follow-up failure at %s leaves the existing investigation/session unchanged', async table=>{
    const accepted=(await post()).json(); await idle(accepted.id);
    await pool.query(`CREATE TRIGGER inject_bridge_failure BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FAIL'`);
    expect((await runs(accepted.id,'retry-run')).statusCode).toBe(503);
    for(const name of ['investigations','chat_sessions','chat_messages','investigation_requests','workflow_jobs','outbox_events']) expect(await all(name)).toHaveLength(1);
    expect((await all('investigations'))[0]).toMatchObject({version:2,active_request_id:null});
    await pool.query('DROP TRIGGER inject_bridge_failure'); expect((await runs(accepted.id,'retry-run')).statusCode).toBe(202);
  });

  it('cancel SQL failure rolls back the intent/job/active pointer together',async()=>{
    const accepted=(await post()).json();
    await pool.query("CREATE TRIGGER inject_bridge_failure BEFORE UPDATE ON workflow_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FAIL'");
    expect((await app.inject({method:'POST',url:`/api/investigations/${accepted.id}/requests/${accepted.requestId}/cancel`,headers})).statusCode).toBe(503);
    expect((await all('investigation_requests'))[0].cancel_requested_at).toBeNull(); expect((await all('workflow_jobs'))[0].state).toBe('queued');
    expect((await all('investigations'))[0].active_request_id).toBe(accepted.requestId);
  });

  it('100 concurrent create retries return one investigation/Session/message/request/job/outbox', async () => {
    const responses = await Promise.all(Array.from({ length: 100 }, () => post()));
    expect(responses.map(r => r.statusCode)).toEqual(Array(100).fill(202));
    expect(new Set(responses.map(r => r.body)).size).toBe(1);
    for (const table of ['investigations','investigation_create_keys','chat_sessions','chat_messages','investigation_requests','workflow_jobs','outbox_events']) expect(await all(table)).toHaveLength(1);
    const accepted = responses[0].json();
    const reordered = { ...payload(), resourceRefs: [...resources].reverse().map(ref => ({ id: ref.id, role: ref.role, type: ref.type })),
      subject: { resource: { id: 101, type: 'instance' }, kind: 'resource' } };
    expect((await post('create-key', reordered as never)).json()).toEqual(accepted);
    expect(accepted).toMatchObject({ id: accepted.investigationId, version: 2 });
    const request = (await all('investigation_requests'))[0];
    expect(request.message_id).toBe((await all('chat_messages'))[0].message_id);
    expect(request.request_snapshot.authority).toMatchObject({ actor: { id: 101, kind: 'user' }, profileId: 'ops' });
    expect(request.request_snapshot.authority.permissions).not.toContain('*');
    expect((await post('create-key', { ...payload(), goal: 'different' })).statusCode).toBe(409);
    await idle(accepted.id);
    expect((await app.inject({ method: 'PATCH', url: `/api/investigations/${accepted.id}`, headers, payload: { expectedVersion: 2, title: 'Updated' } })).statusCode).toBe(200);
    expect((await post()).json()).toEqual(accepted);
    const restarted = new InvestigationSessionBridge(() => pool, authorization);
    expect((await restarted.storeFor(owner).detail({ kind: 'user', id: 101 }, accepted.id)).title).toBe('Updated');
  });

  it('100 same-key HTTP requests append once; different keys compete for one active Session request', async () => {
    const { id } = (await post()).json(); await idle(id);
    const responses = await Promise.all(Array.from({ length: 100 }, () => runs(id, 'follow-key')));
    expect(responses.map(r => r.statusCode)).toEqual(Array(100).fill(202));
    expect(new Set(responses.map(r => r.body)).size).toBe(1);
    expect(await all('chat_messages')).toHaveLength(2);
    expect((await runs(id, 'follow-key', 2, 'changed')).json()).toMatchObject({ error: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    await idle(id);
    const competition = await Promise.all(Array.from({ length: 100 }, (_, i) => runs(id, `different-${i}`, 3)));
    expect(competition.filter(r => r.statusCode === 202)).toHaveLength(1);
    expect(competition.filter(r => r.statusCode === 409)).toHaveLength(99);
    for (const table of ['investigation_requests','workflow_jobs','outbox_events','chat_messages']) expect(await all(table)).toHaveLength(3);
  });

  it.each(['chat_sessions','investigations','investigation_resources','investigation_requests','chat_messages','workflow_jobs','outbox_events','investigation_create_keys'])('create failure at %s rolls back every owned row, then same-key retry succeeds', async table => {
    await pool.query(`CREATE TRIGGER inject_bridge_failure BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected-private-error'`);
    const response = await post(); expect(response.statusCode).toBe(503); expect(response.body).not.toContain('private-error');
    for (const name of ['investigations','investigation_resources','investigation_create_keys','investigation_admission_keys','chat_sessions','chat_messages','investigation_requests','workflow_jobs','outbox_events']) expect(await all(name)).toHaveLength(0);
    await pool.query('DROP TRIGGER inject_bridge_failure'); expect((await post()).statusCode).toBe(202);
  });

  it('authorization precedes list filters/count/limit and cursor stays bound to filters', async () => {
    const visible = (await post('visible')).json();
    const hiddenHeaders = { authorization: `Bearer ${signAccessToken(member, secret)}` };
    await post('hidden', payload(), hiddenHeaders);
    const extra = (await post('extra')).json();
    const response = await app.inject({ url: '/api/investigations?limit=1&state=open&profile=ops&resource=instance:101', headers });
    expect(response.statusCode).toBe(200); const page = response.json();
    expect(page.authorizedCounts.total).toBe(2); expect(page.items).toHaveLength(1);
    const next = await app.inject({ url: `/api/investigations?limit=1&state=open&profile=ops&resource=instance:101&cursor=${page.nextCursor}`, headers });
    expect(next.json().items).toHaveLength(1);
    expect(new Set([...page.items, ...next.json().items].map((x: {id:string}) => x.id))).toEqual(new Set([visible.id,extra.id]));
    expect((await app.inject({ url: `/api/investigations?cursor=${page.nextCursor}`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/investigations?query=missing', headers })).json().authorizedCounts.total).toBe(0);
  });

  it('viewer cannot continue/cancel/patch; plain read share confers no investigation or append access', async () => {
    const accepted = (await post()).json();
    await pool.execute("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,102,'viewer',101)", [accepted.id]);
    const auth = { authorization: `Bearer ${signAccessToken(member, secret)}` };
    expect((await app.inject({ url: `/api/investigations/${accepted.id}`, headers: auth })).statusCode).toBe(200);
    expect((await runs(accepted.id,'viewer-key',2,'no',auth)).statusCode).toBe(403);
    expect((await app.inject({ method:'POST',url:`/api/investigations/${accepted.id}/requests/${accepted.requestId}/cancel`,headers:auth })).statusCode).toBe(403);
    expect((await app.inject({ method:'PATCH',url:`/api/investigations/${accepted.id}`,headers:auth,payload:{expectedVersion:2,title:'no'} })).statusCode).toBe(403);
    await pool.execute('DELETE FROM investigation_members');
    await pool.execute("INSERT INTO chat_session_shares (session_id,recipient_user_id,permission,granted_by) VALUES (?,102,'read',101)",[accepted.sessionId]);
    expect((await app.inject({url:`/api/investigations/${accepted.id}/messages`,headers:auth})).statusCode).toBe(404);
    expect((await runs(accepted.id,'share-key',2,'no',auth)).statusCode).toBe(404);
  });

  it.each(['instance','server','network_device'])('same JWT loses every HTTP view/write/retry after %s scope revocation', async type => {
    const accepted=(await post()).json();
    if(type==='instance') await pool.execute('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
    else await pool.execute('DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code=?',[roleId,type==='server'?'servers:view':'network_devices:view']);
    for(const url of [`/api/investigations/${accepted.id}`,`/api/investigations/${accepted.id}/messages`]) expect((await app.inject({url,headers})).statusCode).toBe(404);
    expect((await app.inject({url:'/api/investigations?limit=1',headers})).json().authorizedCounts.total).toBe(0);
    expect((await post()).statusCode).toBe(404); expect((await runs(accepted.id,'revoked')).statusCode).toBe(404);
    expect((await app.inject({method:'PATCH',url:`/api/investigations/${accepted.id}`,headers,payload:{expectedVersion:2,title:'no'}})).statusCode).toBe(404);
    expect(await all('chat_messages')).toHaveLength(1);
  });

  it('System needs config scope and service identity cannot obtain interactive access', async () => {
    const system={title:'System',goal:'Inspect',profileId:'system',subject:{kind:'platform',component:'api'},resourceRefs:[]};
    expect((await post('system',system as never)).statusCode).toBe(202);
    await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code='config:view'",[roleId]);
    expect((await post('system',system as never)).statusCode).toBe(404);
    const token=jwt.sign({userId:serviceId,username:'admin',sessionVersion:1,permissions:['*'],roles:['admin']},secret,{algorithm:'HS256'});
    expect((await app.inject({url:'/api/investigations',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(401);
    const automatic=(await bridge.create(service,create())).investigation;
    await pool.execute("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,102,'operator',?)",[automatic.id,serviceId]);
    const auth={authorization:`Bearer ${signAccessToken(member,secret)}`};
    expect((await runs(automatic.id,'operator',1,'continue',auth)).statusCode).toBe(202);
    expect((await all('chat_sessions')).find(r=>r.session_id===automatic.sessionId)?.user_id).toBe(serviceId);
  });

  it('conversion retains original message IDs; running Chat and read-share conversion are rejected', async () => {
    const original=await chat.createSession(owner); await chat.addMessage(owner,original.session_id,{messageId:'original-id',role:'user',content:'Original'});
    await chat.grantSessionShare(owner,original.session_id,102,'read');
    const auth={authorization:`Bearer ${signAccessToken(member,secret)}`};
    expect((await post('share-convert',{...payload(),sessionId:original.session_id} as never,auth)).statusCode).toBe(404);
    const runId=randomUUID(); await pool.execute("INSERT INTO agent_runs (id,actor_id,session_id,message_id,idempotency_key,state,expires_at) VALUES (?,101,?,'m','k','running',DATE_ADD(NOW(),INTERVAL 1 DAY))",[runId,original.session_id]);
    expect((await post('convert',{...payload(),sessionId:original.session_id} as never)).statusCode).toBe(409);
    await pool.execute("UPDATE agent_runs SET state='completed' WHERE id=?",[runId]);
    const converted=await post('convert',{...payload(),sessionId:original.session_id} as never); expect(converted.statusCode).toBe(202);
    expect(converted.json().sessionId).toBe(original.session_id); expect((await post('convert',{...payload(),sessionId:original.session_id} as never)).json()).toEqual(converted.json());
    expect((await all('chat_messages')).map(r=>r.message_id).filter(id=>id==='original-id')).toHaveLength(1);
  });

  it('PATCH version competition yields one success and one409; goal and archive are locked while active', async () => {
    const {id}=(await post()).json();
    for(const patch of [{goal:'new'},{lifecycle:'archived'}]) expect((await app.inject({method:'PATCH',url:`/api/investigations/${id}`,headers,payload:{expectedVersion:2,...patch}})).statusCode).toBe(409);
    await idle(id);
    const responses=await Promise.all(['one','two'].map(title=>app.inject({method:'PATCH',url:`/api/investigations/${id}`,headers,payload:{expectedVersion:2,title}})));
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
    const detail=(await app.inject({url:`/api/investigations/${id}`,headers})).json(); expect(detail.version).toBe(3);
  });

  it('queued cancellation records intent and terminal job atomically; repeat is safe', async () => {
    const accepted=(await post()).json();
    const cancel=()=>app.inject({method:'POST',url:`/api/investigations/${accepted.id}/requests/${accepted.requestId}/cancel`,headers});
    expect((await cancel()).statusCode).toBe(202); expect((await cancel()).statusCode).toBe(202);
    expect((await all('workflow_jobs'))[0].state).toBe('cancelled'); expect((await all('investigation_requests'))[0].cancel_requested_at).not.toBeNull();
    expect((await all('investigations'))[0].active_request_id).toBeNull();
  });

  it('running cancellation persists intent without fabricating Run terminal or freeing active request', async () => {
    const accepted=(await post()).json(); await pool.execute("UPDATE workflow_jobs SET state='running' WHERE id=?",[accepted.jobId]);
    expect((await app.inject({method:'POST',url:`/api/investigations/${accepted.id}/requests/${accepted.requestId}/cancel`,headers})).statusCode).toBe(202);
    expect((await all('workflow_jobs'))[0].state).toBe('running'); expect((await all('investigations'))[0].active_request_id).toBe(accepted.requestId);
    expect((await runs(accepted.id,'next')).statusCode).toBe(409);
  });

  it.each([{actor:{id:1}},{permissions:['*']},{profileVersion:999},{goal:' '},{subject:{kind:'platform',component:'api'}},{from:'2026-01-02T00:00:00Z',to:'2026-01-01T00:00:00Z'},{resourceRefs:Array(21).fill(resources[0])}])('rejects invalid or authority-bearing create %j without allocation', async fields=>{
    expect((await post('invalid',{...payload(),...fields} as never)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await all('investigations')).toHaveLength(0);
  });

  it('requires JWT and idempotency header; response never contains private SQL error', async () => {
    expect((await app.inject({url:'/api/investigations'})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/investigations',headers,payload:payload()})).statusCode).toBe(400);
  });
});
