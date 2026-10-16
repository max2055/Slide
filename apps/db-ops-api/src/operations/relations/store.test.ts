/** Synthetic fixtures on real MySQL + real JWT/HTTP; no product LLM calls. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mysql, { type Connection, type Pool } from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import { ActorContextService, signAccessToken, type ActorContext } from '../../auth/actor-context.js';
import { OperationsAuthorization, OPERATIONS_PERMISSIONS } from '../authorization.js';
import { MysqlRelationStore, relationHash, type RelationSession, type StoredRelation } from './store.js';
import { RelationService, type RelationInput } from './service.js';
import { registerRelationRoutes } from './routes.js';
import { InstanceHostService, MysqlInstanceHostStore } from '../../resources/instance-host-service.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('relations: real SQL / JWT / HTTP B05', () => {
  let admin: Connection, pool: Pool, app: FastifyInstance, service: RelationService, store: MysqlRelationStore;
  let now: Date, sourceState: 'valid' | 'withdrawn' | 'unavailable', enabled: boolean;
  let sourceChecks: number, withdrawAfter: number;
  let onEvidence: ((session: RelationSession, relation: StoredRelation) => Promise<void>) | undefined;
  let actor: ActorContext, token: string;
  const database = `p02_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  const ref = (id: number) => ({ type: 'server' as const, id });
  const input = (target = 2, changes: Partial<RelationInput> = {}): RelationInput => ({
    source: ref(1), target: ref(target), relationType: 'depends_on', origin: 'manual',
    observedAt: now.toISOString(), validFrom: new Date(+now - 1000).toISOString(), validUntil: new Date(+now + 60_000).toISOString(),
    evidence: [{ id: 'synthetic-authoritative-source', version: 1, hash: 'a'.repeat(64), validUntil: new Date(+now + 120_000).toISOString() }], ...changes,
  });
  const confirm = async (body: RelationInput = input()) => {
    const value = await service.suggest(actor, body);
    return service.transition(actor, value.id, { expectedVersion: 1, action: 'confirm' });
  };
  const adoptLegacy = async (validUntil: Date | null = null) => {
    const [insert] = await pool.execute<any>(`INSERT INTO resource_relations(source_type,source_id,target_type,target_id,relation_type,provenance,valid_from,valid_until)
      VALUES('instance',1,'server',1,'runs_on','legacy-agent',?,?)`, [new Date(+now - 5000), validUntil]);
    const { source: _s, target: _t, relationType: _r, ...body } = input();
    const value = await service.revise(actor, String(insert.insertId), { ...body, expectedVersion: 0 });
    return service.transition(actor, value.id, { expectedVersion: 1, action: 'confirm' });
  };
  const headers = () => ({ authorization: `Bearer ${token}` });
  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', timezone: 'Z',
      password: process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '' };
    admin = await mysql.createConnection(options);
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 6 });
    for (const sql of [
      'CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, username VARCHAR(64), password_hash VARCHAR(128), status VARCHAR(16), session_version BIGINT DEFAULT 1)',
      'CREATE TABLE roles (id INT PRIMARY KEY, name VARCHAR(64))',
      'CREATE TABLE permissions (id INT PRIMARY KEY, code VARCHAR(128))',
      'CREATE TABLE user_roles (user_id INT, role_id INT, grant_expiry DATETIME NULL)',
      'CREATE TABLE role_permissions (role_id INT, permission_id INT)',
      'CREATE TABLE instance_permissions (user_id INT, instance_id INT, access_level VARCHAR(32), grant_expiry DATETIME NULL)',
      "CREATE TABLE database_instances (id INT PRIMARY KEY, lifecycle_state VARCHAR(32) DEFAULT 'available', name VARCHAR(64) DEFAULT 'synthetic-db', db_type VARCHAR(32) DEFAULT 'mysql', environment VARCHAR(32) DEFAULT 'testing', status VARCHAR(32) DEFAULT 'online', health_status VARCHAR(32) DEFAULT 'unknown')",
      'CREATE TABLE servers (id INT PRIMARY KEY)', 'CREATE TABLE network_devices (id INT PRIMARY KEY)',
      "INSERT INTO users VALUES(1,'p02-author','disabled','active',1),(2,'p02-reviewer','disabled','active',1)",
      "INSERT INTO roles VALUES(1,'p02-operator')", 'INSERT INTO user_roles VALUES(1,1,NULL),(2,1,NULL)',
      'INSERT INTO database_instances(id) VALUES(1),(2)', 'INSERT INTO network_devices VALUES(1)',
    ]) await pool.query(sql);
    const codes = ['instance:view', 'instance:manage', 'servers:view', 'servers:manage', 'network_devices:view', 'network_devices:manage',
      OPERATIONS_PERMISSIONS['context:read'], OPERATIONS_PERMISSIONS['context:manage']];
    for (const [index, code] of codes.entries()) {
      await pool.execute('INSERT INTO permissions VALUES(?,?)', [index + 1, code]);
      await pool.execute('INSERT INTO role_permissions VALUES(1,?)', [index + 1]);
    }
    for (let id = 1; id <= 110; id++) await pool.execute('INSERT INTO servers VALUES(?)', [id]);
    for (const sql of readFileSync(new URL('../../../sql/migrations/029_resource_observations.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) await pool.query(sql);
    for (const sql of readFileSync(new URL('../../../sql/migrations/060_instance_host_relations.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) await pool.query(sql);
    for (const sql of readFileSync(new URL('../../../sql/migrations/061_instance_host_relation_time_precision.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) await pool.query(sql);
    for (const sql of readFileSync(new URL('../schema/operations-v1.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) await pool.query(sql);
    store = new MysqlRelationStore(() => pool);
    const contexts = new ActorContextService(() => pool as any);
    service = new RelationService(store, new OperationsAuthorization(contexts), { check: async (session, _actor, relation) => {
      await onEvidence?.(session, relation);
      return ++sourceChecks > withdrawAfter ? 'withdrawn' : sourceState;
    } },
      () => ({ context: enabled, cases: false, attention: false, baselines: false, plans: false, dispatch: false }), () => now);
    app = Fastify();
    await registerRelationRoutes(app, async (request, reply) => {
      try { (request as any).user = await contexts.authenticateAccessToken(request.headers.authorization?.slice(7) ?? '', secret); }
      catch { return reply.code(401).send({ error: 'UNAUTHORIZED' }); }
    }, service);
    await app.ready();
  }, 30_000);
  beforeEach(async () => {
    now = new Date(); sourceState = 'valid'; enabled = true; sourceChecks = 0; withdrawAfter = Infinity;
    onEvidence = undefined;
    await pool.query('DELETE FROM resource_relation_revisions'); await pool.query('DELETE FROM resource_relations');
    await pool.query('DELETE FROM instance_permissions');
    await pool.query("INSERT INTO instance_permissions VALUES(1,1,'read-write',NULL),(1,2,'read-write',NULL),(2,1,'read-write',NULL)");
    await pool.query('UPDATE users SET session_version=1');
    await pool.query('DELETE FROM role_permissions');
    for (let id = 1; id <= 8; id++) await pool.execute('INSERT INTO role_permissions VALUES(1,?)', [id]);
    const contexts = new ActorContextService(() => pool as any);
    actor = await contexts.loadActiveActor(1); token = signAccessToken(actor, secret);
  });
  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  it('keeps immutable revisions, hashes, review and retraction with stale-version rejection', async () => {
    const value = await confirm();
    expect(value).toMatchObject({ version: 2, state: 'confirmed', confirmedBy: 1 });
    expect(value.contentHash).toBe(relationHash(value));
    await expect(service.transition(actor, value.id, { expectedVersion: 1, action: 'withdraw', reason: 'stale' })).rejects.toMatchObject({ statusCode: 409 });
    const { source: _s, target: _t, relationType: _r, ...body } = input();
    const next = await service.revise(actor, value.id, { ...body, expectedVersion: 2 });
    expect(next.state).toBe('suggested');
    expect(next.confirmedBy).toBeNull(); expect(next.contentHash).not.toBe(value.contentHash);
    const history = await service.history(actor, value.id);
    expect(history.revisions.map(row => row.version)).toEqual([3, 2, 1]);
    expect(history.revisions[1].contentHash).toBe(value.contentHash);
  });

  it('never confirms evidence-free or unavailable/model claims without human review', async () => {
    const value = await service.suggest(actor, input(2, { origin: 'model', evidence: [] }));
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
    await expect(service.transition(actor, value.id, { expectedVersion: 1, action: 'confirm' })).rejects.toMatchObject({ statusCode: 422 });
    const candidate = await service.suggest(actor, input()); sourceState = 'unavailable';
    await expect(service.transition(actor, candidate.id, { expectedVersion: 1, action: 'confirm' })).rejects.toMatchObject({ statusCode: 503 });
  });

  it('serializes simultaneous CAS transitions and rejects a second stale writer', async () => {
    const value = await service.suggest(actor, input());
    const results = await Promise.allSettled([1, 2].map(() => service.transition(actor, value.id, { expectedVersion: 1, action: 'confirm' })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.code).toBe('OPERATIONS_VERSION_CONFLICT');
    const [rows] = await pool.query<any[]>('SELECT version FROM resource_relation_revisions WHERE relation_id=? ORDER BY version', [value.id]);
    expect(rows.map(r => Number(r.version))).toEqual([1, 2]);
  });

  it('invalidates both overlapping confirmations but preserves non-overlapping windows', async () => {
    const first = await confirm(), second = await confirm();
    expect(second.state).toBe('conflicted');
    const head = await store.transaction(s => s.head(first.id));
    expect(head).toMatchObject({ state: 'conflicted', version: 3 });
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
    const third = await confirm(input(3));
    expect(third.state).toBe('confirmed');
  });

  it('rechecks both endpoints and blocks delegated write escalation', async () => {
    const value = await confirm();
    const delegated = { ...actor, resourceBoundary: { instanceIds: [], serverIds: [1], networkDeviceIds: [] } };
    expect(await service.graph(delegated, ref(1))).toEqual({ resource: ref(1), edges: [], partial: true });
    await expect(service.transition(delegated, value.id, { expectedVersion: 2, action: 'withdraw', reason: 'unauthorized' })).rejects.toMatchObject({ statusCode: 403 });
    const [rows] = await pool.query<any[]>('SELECT MAX(version) version FROM resource_relation_revisions');
    expect(Number(rows[0].version)).toBe(2);
  });

  it('filters revoked instances even when an old actor and valid JWT remain', async () => {
    const value = await confirm(input(2, { target: { type: 'instance', id: 1 } }));
    await pool.query('DELETE FROM instance_permissions WHERE user_id=1');
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
    await expect(service.history(actor, value.id)).rejects.toMatchObject({ statusCode: 404 });
    const response = await app.inject({ method: 'GET', url: `/api/operations/relations/${value.id}/revisions`, headers: headers() });
    expect(response.statusCode).toBe(404); expect(response.body).not.toContain('synthetic-authoritative-source');
  });

  it('persists expiry and source withdrawal revisions and never replays stale facts', async () => {
    const first = await confirm(); now = new Date(+now + 61_000);
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
    expect(await store.transaction(s => s.head(first.id))).toMatchObject({ version: 3, state: 'expired' });
    const second = await confirm(input(3)); sourceState = 'withdrawn';
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
    expect(await store.transaction(s => s.head(second.id))).toMatchObject({ version: 3, state: 'withdrawn' });
  });

  it('bounds two-hop traversal, cycles and edge output without hidden counters', async () => {
    await confirm(); await confirm(input(3, { source: ref(2) })); await confirm(input(4, { source: ref(3) }));
    const graph = await service.graph(actor, ref(1));
    expect(graph.edges).toHaveLength(2); expect(graph.partial).toBe(true);
    expect(JSON.stringify(graph)).not.toContain('hiddenCount');
    expect((await service.graph(actor, ref(1), { maxEdges: 1 })).edges).toHaveLength(1);
    await confirm(input(1, { source: ref(3) }));
    expect((await service.graph(actor, ref(1))).partial).toBe(true);
  });

  it('enforces the 100-edge bound with a 101-edge real SQL star', async () => {
    const template = await confirm();
    await store.transaction(async session => {
      for (let id = 3; id <= 102; id++) {
        const value: StoredRelation = { ...template, id: String(2 ** 49 + id), relationId: String(2 ** 49 + id), target: ref(id), contentHash: '' };
        value.contentHash = relationHash(value); await session.append(value);
      }
    });
    const graph = await service.graph(actor, ref(1));
    expect(graph.edges).toHaveLength(100); expect(graph.partial).toBe(true);
    expect(Object.keys(graph).sort()).toEqual(['edges', 'partial', 'resource']);
  }, 20_000);

  it('retains legacy provenance unverified, projects hosts and never dual-writes suggestions', async () => {
    await pool.execute(`INSERT INTO resource_relations(source_type,source_id,target_type,target_id,relation_type,provenance,valid_from)
      VALUES('instance',1,'server',1,'runs_on','legacy-collector',?)`, [new Date(+now - 5000)]);
    const graph = await service.graph(actor, ref(1), { factsOnly: false });
    expect(graph.edges[0]).toMatchObject({ relationType: 'hosts', version: 0, verification: 'unverified', provenance: 'legacy-collector' });
    expect((await service.graph(actor, ref(1))).edges).toEqual([]);
    await service.suggest(actor, input(2, { source: { type: 'instance', id: 1 }, target: ref(2), relationType: 'runs_on' }));
    const [rows] = await pool.query<any[]>('SELECT COUNT(*) n FROM resource_relations'); expect(rows[0].n).toBe(1);
    const oldHosts = new InstanceHostService(new MysqlInstanceHostStore(() => pool as any));
    expect(await oldHosts.listInstances(actor, 1)).toEqual([expect.objectContaining({ instanceId: 1, serverId: 1 })]);
    expect(await oldHosts.listInstances(actor, 2)).toEqual([]);
    await expect(service.suggest(actor, { ...input(), relationType: 'hosts' })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('drops a source withdrawn during a late graph response', async () => {
    await confirm(); sourceChecks = 0; withdrawAfter = 1;
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
  });

  it('invalidates a relation before resource deletion and retains its history rows', async () => {
    const value = await confirm(input(110));
    await service.invalidate(actor, value.id, 2, 'resource_deleted');
    await pool.query('DELETE FROM servers WHERE id=110');
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
    const [rows] = await pool.query<any[]>('SELECT version,state FROM resource_relation_revisions WHERE relation_id=? ORDER BY version', [value.id]);
    expect(rows.map(r => r.state)).toEqual(['suggested', 'confirmed', 'withdrawn']);
    await pool.query('INSERT INTO servers VALUES(110)');
  });

  it('never turns transient evidence unavailability into withdrawal', async () => {
    const value = await confirm(); sourceState = 'unavailable';
    expect(await service.graph(actor, ref(1))).toMatchObject({ edges: [], partial: true });
    expect(await store.transaction(s => s.head(value.id))).toMatchObject({ state: 'confirmed', version: 2 });
    sourceState = 'valid'; expect((await service.graph(actor, ref(1))).edges).toHaveLength(1);
  });

  it('adopts legacy identity only with expectedVersion zero and preserves original provenance', async () => {
    const [insert] = await pool.execute<any>(`INSERT INTO resource_relations(source_type,source_id,target_type,target_id,relation_type,provenance,valid_from)
      VALUES('instance',1,'server',1,'runs_on','legacy-agent',?)`, [new Date(+now - 5000)]);
    const { source: _s, target: _t, relationType: _r, ...body } = input();
    const value = await service.revise(actor, String(insert.insertId), { ...body, expectedVersion: 0 });
    expect(value).toMatchObject({ version: 1, state: 'suggested', legacyProvenance: 'legacy-agent' });
    await service.transition(actor, value.id, { expectedVersion: 1, action: 'confirm' });
    await pool.execute('UPDATE resource_relations SET valid_until=? WHERE id=?', [new Date(+now - 1), insert.insertId]);
    expect((await service.graph(actor, ref(1))).edges).toEqual([]);
    expect(await store.transaction(s => s.head(value.id))).toMatchObject({ version: 3, state: 'withdrawn' });
  });

  it.each(['ended', 'deleted'])('prunes a legacy path %s during the final evidence lookup', async change => {
    const upstream = await adoptLegacy();
    await confirm(); // instance:1 -> server:1 -> server:2
    let reads = 0;
    onEvidence = async (session, value) => {
      if (value.id !== upstream.id || ++reads !== 2) return;
      // A same-transaction source resolver can observe a lifecycle change even
      // while external writers are serialized by the mapping's current lock.
      await session.connection.execute(change === 'deleted' ? 'DELETE FROM resource_relations WHERE id=?'
        : 'UPDATE resource_relations SET valid_until=? WHERE id=?',
      change === 'deleted' ? [value.id] : [new Date(+now - 1), value.id]);
    };
    expect(await service.graph(actor, { type: 'instance', id: 1 })).toMatchObject({ edges: [], partial: true });
    expect(reads).toBe(2);
    expect(await store.transaction(s => s.head(upstream.id))).toMatchObject({ version: 3, state: 'withdrawn' });
    expect((await service.history(actor, upstream.id)).revisions.map(r => r.state)).toEqual(['withdrawn', 'confirmed', 'suggested']);
  });

  it('prunes a path when the legacy source window expires during a later asynchronous lookup', async () => {
    const upstream = await adoptLegacy(new Date(+now + 1000));
    const downstream = await confirm();
    let reads = 0;
    onEvidence = async (_session, value) => {
      if (value.id === downstream.id && ++reads === 2) now = new Date(+now + 2000);
    };
    expect(await service.graph(actor, { type: 'instance', id: 1 })).toMatchObject({ edges: [], partial: true });
    expect(reads).toBe(2);
    expect((await service.history(actor, upstream.id)).revisions).toHaveLength(2);
  });

  it.each(['ended', 'deleted'])('serializes concurrent legacy %s writers through graph commit', async change => {
    const value = await adoptLegacy();
    let checked = false;
    onEvidence = async () => {
      if (checked) return;
      checked = true;
      const writer = await pool.getConnection();
      try {
        await writer.query('SET SESSION innodb_lock_wait_timeout=1');
        await writer.beginTransaction();
        const write = writer.execute(change === 'deleted' ? 'DELETE FROM resource_relations WHERE id=?'
          : 'UPDATE resource_relations SET valid_until=? WHERE id=?',
        change === 'deleted' ? [value.id] : [new Date(+now - 1), value.id]);
        await expect(write).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
      } finally { await writer.rollback(); writer.release(); }
    };
    expect((await service.graph(actor, { type: 'instance', id: 1 })).edges).toHaveLength(1);
    expect(checked).toBe(true);
    onEvidence = undefined;
    await pool.execute(change === 'deleted' ? 'DELETE FROM resource_relations WHERE id=?'
      : 'UPDATE resource_relations SET valid_until=? WHERE id=?',
    change === 'deleted' ? [value.id] : [new Date(+now - 1), value.id]);
    expect(await service.graph(actor, { type: 'instance', id: 1 })).toMatchObject({ edges: [], partial: true });
  });

  it('withdraws with the feature off and retains immutable audit history', async () => {
    const value = await confirm(); enabled = false;
    await expect(service.suggest(actor, input())).rejects.toMatchObject({ statusCode: 422 });
    await service.transition(actor, value.id, { expectedVersion: 2, action: 'withdraw', reason: 'operator-retracted' });
    const history = await service.history(actor, value.id, undefined, 2);
    expect(history.partial).toBe(true); expect(history.revisions.map(v => v.version)).toEqual([3, 2]);
    expect(history.revisions[0].withdrawalReason).toBe('operator-retracted');
    expect((await service.history(actor, value.id, 2)).revisions[0]).toMatchObject({ state: 'suggested', version: 1 });
  });

  it('serves business HTTP with strict inputs, safe errors, no-store and live JWT rejection', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/operations/relations', headers: headers(), payload: input() });
    expect(made.statusCode).toBe(200); const value = made.json();
    const review = await app.inject({ method: 'POST', url: `/api/operations/relations/${value.id}/review`, headers: headers(), payload: { action: 'confirm', expectedVersion: 1 } });
    expect(review.statusCode).toBe(200);
    const graph = await app.inject({ method: 'GET', url: '/api/operations/resources/server/1/relations', headers: headers() });
    expect(graph.statusCode).toBe(200); expect(graph.json().edges).toHaveLength(1); expect(graph.headers['cache-control']).toBe('no-store');
    for (const query of ['hops=3', 'maxEdges=101', 'factsOnly=maybe', 'unexpected=1']) {
      expect((await app.inject({ method: 'GET', url: `/api/operations/resources/server/1/relations?${query}`, headers: headers() })).statusCode).toBe(422);
    }
    const invalid = await app.inject({ method: 'POST', url: '/api/operations/relations', headers: headers(), payload: { ...input(), state: 'confirmed' } });
    expect(invalid.statusCode).toBe(422);
    await pool.query('UPDATE users SET session_version=2 WHERE id=1');
    expect((await app.inject({ method: 'GET', url: '/api/operations/resources/server/1/relations', headers: headers() })).statusCode).toBe(401);
  });
});
