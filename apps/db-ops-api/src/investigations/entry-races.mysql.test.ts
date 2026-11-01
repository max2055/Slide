import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { dbConnection } from '../db-connection.js';
import { ActorContextService, signAccessToken } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { alertEventService } from '../alert-event-service.js';
import { identify, sample } from '../contracts/metrics/fixtures.js';
import { RolloutControl } from '../metrics/rollout/control.js';
import { seriesHash } from '../metrics/storage.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { MysqlInvestigationStore } from './store.js';
import { registerInvestigationEntryRoutes } from './entry-routes.js';

const port = Number(process.env.MAX242_TEST_MYSQL_PORT);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
/** Only scheduling barriers are intercepted: JWT, grants, events, metrics and all writes use real SQL. */
describe.skipIf(!port || port === 3306)('MAX242 final entry boundaries over real JWT/HTTP/MySQL', () => {
  const database = `max242_races_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID(), userId = 8422, resourceId = 8422;
  let root: Pool, pool: Pool, app: FastifyInstance, origin: string, token: string, savedId: string;
  let context: any, originalPool: typeof dbConnection.getPool;
  let phase = '', episodeReads = 0, scopeReads = 0, detailReads = 0;
  let reached = deferred(), release = deferred();
  let revokeCommitted = false;
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of ['investigations','chat_sessions','investigation_create_keys','investigation_admission_keys','investigation_requests','agent_runs','workflow_jobs'])
      result[table] = Number((await pool.query<any[]>(`SELECT COUNT(*) n FROM ${table}`))[0][0].n);
    return result;
  };
  const send = async (kind: string) => {
    const r = await fetch(origin + (kind === 'stored' ? `/api/investigations/${savedId}/context-facts`
      : `/api/investigations/${kind === 'save' ? 'drafts' : 'entry-facts'}`), {
      method: kind === 'stored' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      ...(kind === 'stored' ? {} : { body: JSON.stringify(context) }),
    });
    return { status: r.status, body: await r.json() as any, cache: r.headers.get('cache-control') };
  };
  const pause = async () => { reached.resolve(); await release.promise; };
  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.MAX242_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    root = mysql.createPool(options); await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run();
    originalPool = dbConnection.getPool; dbConnection.getPool = () => pool;
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(8422,'max242-race-reader','disabled-login-fixture')");
    await pool.query("INSERT INTO roles(id,name) VALUES(8422,'max242-race-reader')");
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 8422,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(8422,8422)');
    await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,db_version) VALUES(8422,'race evidence','fixture.invalid',3306,'fixture','unused','mysql','9.6.0')");
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(8422,8422,'read-only')");
    const event = await alertEventService.createEvent({ event_id: randomUUID(), title: 'Controlled source event', instance_id: resourceId, severity: 'warning' });
    expect(event.success).toBe(true);
    const now = Date.now(), at = new Date(now - 60000).toISOString();
    context = { schemaVersion: 1, resourceRefs: [{ type: 'instance', id: resourceId, role: 'primary' }],
      from: new Date(now - 600000).toISOString(), to: new Date(now).toISOString(),
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, dimensions: {}, sourceEventIds: [event.eventId], returnTo: `/instance-detail?id=${resourceId}&tab=metrics` };
    const fixture = sample('db.uptime_seconds');
    const observation = identify({ ...fixture, resource_id: String(resourceId), observed_at: at, collected_at: at, stored_at: at,
      value: { encoding: 'float64', value: 424242 }, source: { ...fixture.source, attempt_id: 'max242-race-fixture' } });
    const control = new RolloutControl(pool);
    await control.initialize(observation, { source: 'semantic', read: 'semantic', revision: 1, package: { id: 'fixture', version: '1.0.0', digest: 'sha256:' + 'a'.repeat(64) } });
    await control.applied(observation, { source: 'semantic', generation: 1, revision: 1 });
    const time = at.slice(0,23).replace('T',' ');
    await pool.execute('INSERT INTO metric_observations(id,series_hash,stage,observed_at,stored_at,valid_value,payload,payload_hash,evidence_expires_at) VALUES(?,?,?,?,?,1,?,?,NULL)',
      [observation.id, seriesHash(observation), observation.stage, time, time, JSON.stringify(observation), 'fixture']);
    await pool.execute('INSERT INTO metric_publications(observation_id,series_hash,generation,observed_at) VALUES(?,?,1,?)', [observation.id, seriesHash(observation), time]);
    const contexts = new ActorContextService(() => pool as unknown as ReturnType<NonNullable<ConstructorParameters<typeof ActorContextService>[0]>>);
    token = signAccessToken(await contexts.loadActiveActor(userId), secret);
    app = Fastify();
    await registerInvestigationEntryRoutes(app, createVerifyToken(secret, contexts), new InvestigationSessionBridge(() => pool));
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const initial = await send('preview'); expect(initial.status).toBe(200);
    expect(initial.body.facts[0].observations[0].value.value).toBe(424242);
    const saved = await send('save'); expect(saved.status).toBe(200); savedId = saved.body.id;
  }, 120000);
  beforeEach(async () => {
    await pool.query("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 8422,id FROM permissions WHERE code='alert:view'");
    phase = ''; episodeReads = scopeReads = detailReads = 0; reached = deferred(); release = deferred(); revokeCommitted = false;
    const execute = pool.execute.bind(pool);
    vi.spyOn(pool, 'execute').mockImplementation((async (...args: any[]) => {
      const result = await (execute as any)(...args);
      if (phase === 'event-io' && String(args[0]).includes('SELECT payload FROM metric_trigger_episodes') && ++episodeReads === 4) await pause();
      return result;
    }) as any);
    const authorize = InvestigationAuthorization.prototype.authorize;
    vi.spyOn(InvestigationAuthorization.prototype, 'authorize').mockImplementation(async function (...args) {
      if (phase === 'scope' && args[2].id === 'entry-preview' && ++scopeReads === 2) await pause();
      return authorize.apply(this, args);
    });
    const create = MysqlInvestigationStore.prototype.createInTransaction;
    vi.spyOn(MysqlInvestigationStore.prototype, 'createInTransaction').mockImplementation(async function (...args) {
      if (phase === 'create') await pause();
      return create.apply(this, args);
    });
    const detail = MysqlInvestigationStore.prototype.detail;
    vi.spyOn(MysqlInvestigationStore.prototype, 'detail').mockImplementation(async function (...args) {
      const result = await detail.apply(this, args);
      if (phase === 'detail' && ++detailReads === 2) await pause();
      return result;
    });
  });
  afterEach(() => { release.resolve(); vi.restoreAllMocks(); });
  afterAll(async () => {
    release.resolve(); await app?.close(); dbConnection.getPool = originalPool;
    await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  it.each(['preview','save','stored'].flatMap(kind => ['event-io','scope'].map(boundary => [kind,boundary])))('%s rejects a committed alert:view revocation during final %s', async (kind, boundary) => {
    const before = await counts(); phase = boundary;
    const pending = send(kind);
    try {
      await Promise.race([reached.promise, new Promise((_, reject) => setTimeout(() => reject(Error('BOUNDARY_NOT_REACHED')), 10000))]);
      await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON rp.permission_id=p.id WHERE rp.role_id=8422 AND p.code='alert:view'");
      revokeCommitted = true; release.resolve(); const result = await pending;
      expect(revokeCommitted).toBe(true); expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'INVESTIGATION_NOT_FOUND' }); expect(result.cache).toContain('no-store');
      expect(await counts()).toEqual(before);
    } finally { phase = ''; release.resolve(); await pending; }
  }, 20000);
  it.each([['save','create'], ['stored','detail']])('%s fences the later %s persistence/response boundary too', async (kind, boundary) => {
    const before = await counts(); phase = boundary;
    const pending = send(kind);
    try {
      await Promise.race([reached.promise, new Promise((_, reject) => setTimeout(() => reject(Error('BOUNDARY_NOT_REACHED')), 10000))]);
      await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON rp.permission_id=p.id WHERE rp.role_id=8422 AND p.code='alert:view'");
      release.resolve(); const result = await pending;
      expect(result.status).toBe(404); expect(result.body).toEqual({ error: 'INVESTIGATION_NOT_FOUND' });
      expect(await counts()).toEqual(before);
    } finally { phase = ''; release.resolve(); await pending; }
  }, 20000);
});
