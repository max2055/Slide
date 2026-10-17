/** Synthetic event/proof/window inputs; production event ingest, migrations,
 * MySQL transactions, ACL, JWT and listening HTTP. No Provider or VM actions. */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { startFeedbackFixture } from '../../investigations/feedback-test-fixture.js';
import { provisionInvestigationServiceIdentity } from '../../investigations/authorization.js';
import { MysqlInvestigationBudgetLedger } from '../../investigations/budget-ledger.js';
import { MysqlOperationalEventIngest } from '../../investigations/event-ingest.js';
import type { EventInput } from '../../investigations/trigger-policy.js';
import { OutboxService } from '../../workflows/outbox-service.js';
import { signAccessToken, type ActorContext } from '../../auth/actor-context.js';
import { createVerifyToken } from '../../auth-middleware.js';
import { OperationsAuthorization } from '../authorization.js';
import { operationsContentHash } from '../contracts.js';
import { operationsFlags } from '../feature-flags.js';
import { RelationService, type RelationEvidence } from '../relations/service.js';
import { MysqlRelationStore, type RelationSession } from '../relations/store.js';
import { BaselineStore } from '../baselines/store.js';
import { syntheticInput, syntheticWindow } from '../baselines/test-support.js';
import { HOUR, type BaselineSource } from '../baselines/source-adapter.js';
import { AttentionStore } from './store.js';
import { registerAttentionRoutes } from './routes.js';
import { observationWindow } from './correlator.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('P05 B08 production MySQL/JWT/listening HTTP (synthetic inputs)', () => {
  let f: Awaited<ReturnType<typeof startFeedbackFixture>>, actor: ActorContext, serviceActor: ActorContext;
  let store: AttentionStore, relations: RelationService, base: string, now: number, enabled: boolean, baselineEnabled: boolean;
  let onEvidence: ((session: RelationSession) => Promise<void>) | undefined;
  const signatures: Record<string, string> = {};
  const ref = (id: number) => ({ type: 'instance' as const, id });
  const input = (ids = [101, 102]) => ({ observedAt: new Date(now - 1000).toISOString(), resources: ids.map(ref) });
  const from = () => observationWindow(input().observedAt).from;
  const request = async (path = '/api/operations/attention', method = 'POST', body: unknown = input(), caller = actor) => {
    const result = await fetch(base + path, { method, headers: { authorization: `Bearer ${signAccessToken(caller, f.secret)}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, body: await result.json() as any, cache: result.headers.get('cache-control') };
  };
  const get = (id: string, query = '') => request(`/api/operations/attention/${id}${query}`, 'GET');
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of ['operational_events', 'investigations', 'investigation_requests', 'agent_runs', 'attention_correlation_snapshots'])
      result[table] = Number((await f.rows(`SELECT COUNT(*) n FROM ${table}`))[0].n);
    return result;
  };
  const emit = async (id = 101, seconds = 5, extra: Partial<EventInput> = {}) => {
    const event: EventInput = { schemaVersion: 1, sourceEventId: randomUUID(), kind: 'failure', subject: { kind: 'resource', resource: ref(id) },
      occurredAt: new Date(Date.parse(from()) + seconds * 1000).toISOString(), severity: 'error', summary: 'Synthetic latency; no business loss assertion',
      origin: 'collector', stableErrorCode: 'TIMEOUT', callsite: 'fixture.read', ...extra };
    const binding = { source: 'p05-trusted-fixture', verified: true, allowedOrigins: ['collector' as const],
      policy: { id: 'p05', version: 1, domain: 'p05-no-admission', actor: serviceActor, profileId: 'ops' as const, profileVersion: 1,
        resources: [101, 102, 104].map(id => ({ ...ref(id), role: 'primary' as const })), kinds: ['failure'], threshold: 10000,
        windowMs: 300_000, cooldownMs: 600_000, criticalSingle: false, reserveTokens: 100, reserveCostMicros: 100 } };
    const ledger = new MysqlInvestigationBudgetLedger(() => f.pool, { currency: 'USD', maxConcurrent: 1, manualReserved: 0, maxPerResourceConcurrent: 1,
      maxAutomaticRequestsPerHour: 1, maxAutomaticTokensPerDay: 100, maxTotalTokensPerDay: 100, maxCostMicrosPerDay: 100 });
    const result = await new MysqlOperationalEventIngest(() => f.pool, binding, ledger, f.authorization, f.bridge).ingest(event);
    expect(result.disposition).toBe('suppressed'); expect(result.suppressionReason).toBe('BELOW_THRESHOLD'); return result.eventId;
  };
  const evidence: RelationEvidence = { check: async (session) => {
    await onEvidence?.(session);
    const [result] = await session.connection.execute<any[]>('SELECT state FROM p05_fixture_proof WHERE id=1 FOR SHARE');
    return result[0]?.state ?? 'unavailable';
  } };
  const relation = async (legacy = false) => {
    let id: string | undefined;
    if (legacy) {
      const [r] = await f.pool.execute<any>(`INSERT INTO resource_relations(source_type,source_id,target_type,target_id,relation_type,provenance,valid_from)
        VALUES('instance',101,'instance',102,'depends_on','manual',?)`, [new Date(now - 60_000)]); id = String(r.insertId);
    }
    const value = { source: ref(101), target: ref(102), relationType: 'depends_on', origin: 'manual', observedAt: new Date(now - 60_000).toISOString(),
      validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 120_000).toISOString(),
      evidence: [{ id: 'synthetic-proof', version: 1, hash: 'a'.repeat(64), validUntil: new Date(now + 120_000).toISOString() }] };
    let proposed;
    if (id) { const { source: _s, target: _t, relationType: _r, ...content } = value; proposed = await relations.revise(actor, id, { ...content, expectedVersion: 0 }); }
    else proposed = await relations.suggest(actor, value);
    return relations.transition(actor, proposed.relationId, { expectedVersion: proposed.version, action: 'confirm' });
  };
  beforeAll(async () => {
    const old = process.env.T11_TEST_MYSQL_PASSWORD; process.env.T11_TEST_MYSQL_PASSWORD = process.env.OPERATIONS_TEST_MYSQL_PORT
      ? process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? '' : process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '';
    try { f = await startFeedbackFixture(port); } finally { if (old === undefined) delete process.env.T11_TEST_MYSQL_PASSWORD; else process.env.T11_TEST_MYSQL_PASSWORD = old; }
    for (const sql of readFileSync(new URL('../schema/operations-v1.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) await f.pool.query(sql);
    await f.rows('CREATE TABLE p05_fixture_proof(id INT PRIMARY KEY,state VARCHAR(32) NOT NULL)');
    await f.rows("INSERT INTO p05_fixture_proof VALUES(1,'valid')");
    await f.rows("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(104,'third','fixture.invalid',3306,'fixture','unused')");
    for (const code of ['operations:context:view', 'operations:context:manage', 'instance:manage']) {
      await f.rows('INSERT IGNORE INTO permissions(code,description) VALUES(?,?)', [code, 'P05 fixture']);
      await f.rows('INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code=?', [code]);
    }
    const serviceId = await new OutboxService(f.pool as never).transaction(c => provisionInvestigationServiceIdentity(c, 'p05-fixture'));
    await f.rows("INSERT INTO roles(id,name) VALUES(201,'p05-readonly-service')");
    await f.rows("INSERT INTO role_permissions(role_id,permission_id) SELECT 201,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')");
    await f.rows('INSERT INTO user_roles(user_id,role_id) VALUES(?,201)', [serviceId]);
    await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(?,101,'read-only'),(?,102,'read-only'),(?,104,'read-only')", [serviceId, serviceId, serviceId]);
    serviceActor = { ...await new OutboxService(f.pool as never).transaction(c => f.contexts.loadInvestigationActorFrom(c, serviceId, 'service', 1)),
      resourceBoundary: { instanceIds: [101, 102, 104], serverIds: [], networkDeviceIds: [] } };
    const flags = () => ({ ...operationsFlags({}), attention: enabled, context: true, baselines: baselineEnabled });
    store = new AttentionStore(() => f.pool, f.contexts, evidence, signatures, flags, () => new Date(now));
    relations = new RelationService(new MysqlRelationStore(() => f.pool), new OperationsAuthorization(f.contexts), evidence, flags, () => new Date(now));
    await registerAttentionRoutes(f.app, createVerifyToken(f.secret, f.contexts), store);
    base = await f.app.listen({ host: '127.0.0.1', port: 0 });
  }, 120_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    // A completed previous quarter hour avoids real wall-clock/SQL future races.
    now = Date.parse(observationWindow(new Date().toISOString()).from) - 1000;
    enabled = true; baselineEnabled = true; onEvidence = undefined;
    for (const key of Object.keys(signatures)) delete signatures[key];
    await f.rows('DELETE FROM attention_snapshot_members');
    for (const snapshot of await f.rows('SELECT id,version FROM attention_correlation_snapshots ORDER BY version DESC'))
      await f.rows('DELETE FROM attention_correlation_snapshots WHERE id=? AND version=?', [snapshot.id, snapshot.version]);
    for (const table of ['investigation_event_links', 'operational_events', 'investigation_trigger_keys', 'resource_relation_revisions', 'resource_relations', 'behavior_baseline_versions']) await f.rows(`DELETE FROM ${table}`);
    await f.rows("UPDATE p05_fixture_proof SET state='valid'");
    await f.rows('UPDATE users SET session_version=1 WHERE id IN (101,102,103)');
    await f.rows('UPDATE user_roles SET grant_expiry=NULL WHERE user_id=101');
    await f.rows("UPDATE database_instances SET lifecycle_state='available',host='fixture.invalid',status='active' WHERE id IN (101,102,104)");
    await f.rows("INSERT IGNORE INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,101,'read-write'),(101,102,'read-write'),(101,104,'read-write')");
    await f.rows("UPDATE instance_permissions SET access_level='read-write',grant_expiry=NULL WHERE user_id=101");
    for (const code of ['operations:context:view', 'operations:context:manage', 'instance:manage']) await f.rows('INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code=?', [code]);
    actor = await f.contexts.loadActiveActor(101);
  });
  it('R1 rejects resource expiry during the last principal reload without delivering content', async () => {
    await emit(); const saved = await store.compute(actor, input([101]));
    await f.rows("UPDATE instance_permissions SET grant_expiry=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101 AND instance_id=101");
    let principalReads = 0; let finalActor: ActorContext | undefined;
    const slowContexts = new Proxy(f.contexts, { get(target, name) {
      if (name === 'loadInvestigationActorFrom') return async (...args: Parameters<typeof target.loadInvestigationActorFrom>) => {
        const direct = new Error().stack?.split('\n')[2]?.includes('AttentionStore.principal');
        if (direct && ++principalReads === 3) await args[0].execute('SELECT SLEEP(2.2)');
        const current = await target.loadInvestigationActorFrom(...args);
        if (direct && principalReads === 3) finalActor = current;
        return current;
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const slow = new AttentionStore(() => f.pool, slowContexts, evidence, signatures,
      () => ({ ...operationsFlags({}), attention: true, context: true }), () => new Date(now));
    const delivered = vi.fn();
    const result = await slow.read(actor, saved.id, {}, delivered).then(page => ({ page, error: null }), error => ({ page: null, error }));
    expect(principalReads).toBe(3); expect(finalActor!.instanceScopes).not.toHaveProperty('101');
    expect((await f.rows('SELECT grant_expiry<=UTC_TIMESTAMP(3) expired FROM instance_permissions WHERE user_id=101 AND instance_id=101'))[0].expired).toBe(1);
    expect(result.error).toMatchObject({ code: 'OPERATIONS_NOT_FOUND' });
    expect(result.page).toBeNull(); expect(delivered).not.toHaveBeenCalled();
  });
  it('R1 uses the last principal resource scope after same-transaction revocation', async () => {
    await emit(); const saved = await store.compute(actor, input([101]));
    let directReads = 0; let finalActor: ActorContext | undefined;
    const contexts = new Proxy(f.contexts, { get(target, name) {
      if (name === 'loadInvestigationActorFrom') return async (...args: Parameters<typeof target.loadInvestigationActorFrom>) => {
        const direct = new Error().stack?.split('\n')[2]?.includes('AttentionStore.principal');
        if (direct && ++directReads === 3) await args[0].execute('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
        const current = await target.loadInvestigationActorFrom(...args);
        if (direct && directReads === 3) finalActor = current;
        return current;
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const changed = new AttentionStore(() => f.pool, contexts, evidence, signatures,
      () => ({ ...operationsFlags({}), attention: true, context: true }), () => new Date(now));
    const delivered = vi.fn();
    await expect(changed.read(actor, saved.id, {}, delivered)).rejects.toMatchObject({ code: 'OPERATIONS_NOT_FOUND' });
    expect(directReads).toBe(3); expect(finalActor!.instanceScopes).not.toHaveProperty('101'); expect(delivered).not.toHaveBeenCalled();
    // The injected mutation belongs to the failed read transaction and rolls back.
    expect(await f.rows('SELECT instance_id FROM instance_permissions WHERE user_id=101 AND instance_id=101')).toHaveLength(1);
  });
  // Delay AFTER the real final actor query too: its grants may still look live
  // while membership/role/resource TTL expires before the callback is reached.
  const delayedProjection = (afterRead: (actor: ActorContext) => void = () => {}) => {
    let directReads = 0;
    const contexts = new Proxy(f.contexts, { get(target, name) {
      if (name === 'loadInvestigationActorFrom') return async (...args: Parameters<typeof target.loadInvestigationActorFrom>) => {
        const direct = new Error().stack?.split('\n')[2]?.includes('AttentionStore.principal');
        const current = await target.loadInvestigationActorFrom(...args);
        if (direct && ++directReads === 3) { afterRead(current); await args[0].execute('SELECT SLEEP(2.2)'); }
        return current;
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return new AttentionStore(() => f.pool, contexts, evidence, signatures,
      () => ({ ...operationsFlags({}), attention: true, context: true }), () => new Date(now));
  };
  it.each(['resource', 'role', 'investigation_member', 'investigation_scope'])('R1 rejects %s expiry after final actor query, with no late callback', async kind => {
    const event = await emit();
    let investigationId: string | undefined;
    if (kind.startsWith('investigation_')) {
      const source = await f.seed(); investigationId = source.inv.id;
      await f.rows('UPDATE operational_events SET investigation_id=? WHERE id=?', [investigationId, event]);
      if (kind === 'investigation_member') {
        await f.rows('UPDATE investigations SET owner_id=103 WHERE id=?', [investigationId]);
        await f.rows("INSERT INTO investigation_members(investigation_id,user_id,role,granted_by) VALUES(?,101,'viewer',103)", [investigationId]);
      }
    }
    const saved = await store.compute(actor, input([101])); expect(saved.items).toHaveLength(1);
    if (kind === 'role') await f.rows('UPDATE user_roles SET grant_expiry=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101');
    else if (kind === 'investigation_member') await f.rows('UPDATE investigation_members SET expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101 AND investigation_id=?', [investigationId]);
    else await f.rows('UPDATE instance_permissions SET grant_expiry=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101 AND instance_id=?', [kind === 'investigation_scope' ? 102 : 101]);
    let observed: ActorContext | undefined; const delayed = delayedProjection(current => { observed = current; });
    const delivered = vi.fn();
    await expect(delayed.read(actor, saved.id, {}, delivered)).rejects.toMatchObject({ code: 'OPERATIONS_NOT_FOUND' });
    expect(observed!.instanceScopes).toHaveProperty('101'); expect(observed!.permissions).toContain('operations:context:view');
    expect(delivered).not.toHaveBeenCalled();
    if (kind === 'investigation_member') expect((await f.rows('SELECT expires_at<=UTC_TIMESTAMP(3) expired FROM investigation_members WHERE investigation_id=? AND user_id=101', [investigationId]))[0].expired).toBe(1);
    else if (kind === 'role') expect((await f.rows('SELECT grant_expiry<=UTC_TIMESTAMP(3) expired FROM user_roles WHERE user_id=101'))[0].expired).toBe(1);
    else expect((await f.rows('SELECT grant_expiry<=UTC_TIMESTAMP(3) expired FROM instance_permissions WHERE user_id=101 AND instance_id=?', [kind === 'investigation_scope' ? 102 : 101]))[0].expired).toBe(1);
    // A fresh read projects remaining authority consistently instead of keeping
    // stale counts or the saved investigation scope.
    const fresh = await store.read(actor, saved.id).catch(error => { expect(error.code).toBe('OPERATIONS_NOT_FOUND'); return null; });
    if (fresh) { expect(fresh.items).toEqual([]); expect(fresh.authorizedCounts.total).toBe(0); expect(fresh.nextCursor).toBeNull(); expect(fresh.override).toBeNull(); }
  });
  it('R1 fences expiry across multiple groups, stable cursor and retained override history', async () => {
    const a = await emit(), b = await emit(102), c = await emit(104);
    const saved = await store.compute(actor, input([101, 102, 104]));
    const overridden = await store.override(actor, saved.id, { expectedVersion: saved.version, reason: 'Retained synthetic split', partitions: [[a], [b], [c]] });
    const first = await store.read(actor, saved.id, { version: overridden.version, limit: 1 });
    expect(first.authorizedCounts.total).toBe(3); expect(first.nextCursor).not.toBeNull(); expect(first.override).not.toBeNull();
    const before = await f.rows('SELECT snapshot FROM attention_correlation_snapshots WHERE id=? ORDER BY version', [saved.id]);
    await f.rows('UPDATE instance_permissions SET grant_expiry=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101 AND instance_id=101');
    const delivered = vi.fn();
    await expect(delayedProjection().read(actor, saved.id, { version: overridden.version, limit: 1, cursor: first.nextCursor! }, delivered))
      .rejects.toMatchObject({ code: 'OPERATIONS_NOT_FOUND' });
    expect(delivered).not.toHaveBeenCalled();
    await expect(store.read(actor, saved.id, { version: overridden.version, limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'OPERATIONS_VERSION_CONFLICT' });
    const fresh = await store.read(actor, saved.id, { version: overridden.version });
    expect(fresh.authorizedCounts.total).toBe(2); expect(fresh.override).toBeNull(); expect(JSON.stringify(fresh)).not.toContain(a);
    expect(await f.rows('SELECT snapshot FROM attention_correlation_snapshots WHERE id=? ORDER BY version', [saved.id])).toEqual(before);
  });
  it('R1 fences an intermediate resource expiring after historical path validation', async () => {
    await emit(); await emit(102);
    for (const [source, target] of [[101, 104], [104, 102]]) {
      const proposed = await relations.suggest(actor, { source: ref(source), target: ref(target), relationType: 'depends_on', origin: 'manual',
        observedAt: new Date(now - 60_000).toISOString(), validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 120_000).toISOString(),
        evidence: [{ id: 'synthetic-proof', version: 1, hash: 'a'.repeat(64), validUntil: new Date(now + 120_000).toISOString() }] });
      await relations.transition(actor, proposed.relationId, { expectedVersion: proposed.version, action: 'confirm' });
    }
    const saved = await store.compute(actor, input()); expect(saved.items[0].recordedReasons[0].relationIds).toHaveLength(2);
    await f.rows('UPDATE instance_permissions SET grant_expiry=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101 AND instance_id=104');
    const delivered = vi.fn();
    await expect(delayedProjection().read(actor, saved.id, {}, delivered)).rejects.toMatchObject({ code: 'OPERATIONS_NOT_FOUND' });
    expect(delivered).not.toHaveBeenCalled();
    const fresh = await store.read(actor, saved.id);
    expect(fresh.items[0]).toMatchObject({ currentValidity: 'unknown', reasons: [], recordedReasons: [] });
    for (const id of saved.items[0].recordedReasons[0].relationIds) expect(JSON.stringify(fresh)).not.toContain(id);
  });
  it('R1 listening HTTP returns only 404 after expiry during the final query callback', async () => {
    await emit(); const saved = await store.compute(actor, input([101]));
    await f.rows('UPDATE instance_permissions SET grant_expiry=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101 AND instance_id=101');
    const app = Fastify();
    try {
      await registerAttentionRoutes(app, createVerifyToken(f.secret, f.contexts), delayedProjection());
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${address}/api/operations/attention/${saved.id}`, { headers: { authorization: `Bearer ${signAccessToken(actor, f.secret)}` } });
      const body = await response.json();
      expect((await f.rows('SELECT grant_expiry<=UTC_TIMESTAMP(3) expired FROM instance_permissions WHERE user_id=101 AND instance_id=101'))[0].expired).toBe(1);
      expect(response.status).toBe(404); expect(body).toEqual({ error: 'OPERATIONS_NOT_FOUND' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    } finally { await app.close(); }
  });
  it('R1 checks the SQL expiry horizon immediately before delivery, after synchronous page assembly', async () => {
    await emit(); const saved = await store.compute(actor, input([101]));
    await f.rows('UPDATE instance_permissions SET grant_expiry=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=101 AND instance_id=101');
    let directReads = 0, armed = false, delayed = false;
    const contexts = new Proxy(f.contexts, { get(target, name) {
      if (name === 'loadInvestigationActorFrom') return async (...args: Parameters<typeof target.loadInvestigationActorFrom>) => {
        const direct = new Error().stack?.split('\n')[2]?.includes('AttentionStore.principal');
        const current = await target.loadInvestigationActorFrom(...args);
        if (direct && ++directReads === 3) armed = true;
        return current;
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const slow = new AttentionStore(() => f.pool, contexts, evidence, signatures, () => {
      if (armed && !delayed) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200); }
      return { ...operationsFlags({}), attention: true, context: true };
    }, () => new Date(now));
    const delivered = vi.fn();
    await expect(slow.read(actor, saved.id, {}, delivered)).rejects.toMatchObject({ code: 'OPERATIONS_NOT_FOUND' });
    expect(delayed).toBe(true); expect(delivered).not.toHaveBeenCalled();
    expect((await f.rows('SELECT grant_expiry<=UTC_TIMESTAMP(3) expired FROM instance_permissions WHERE user_id=101 AND instance_id=101'))[0].expired).toBe(1);
  });
  it('consumes production ingested events read-only, records immutable explanations and zero additional runs', async () => {
    const a = await emit(), b = await emit(101, 60);
    const before = await counts(), response = await request();
    expect(response.status).toBe(200); expect(response.cache).toBe('private, no-store');
    expect(response.body.items[0]).toMatchObject({ eventIds: [a, b].sort(), correlationIsCausation: false, impactStatus: 'unknown', score: { components: { impact: null, baseline: null } } });
    expect(response.body.modelCalls).toBe(0);
    const after = await counts(); expect({ ...after, attention_correlation_snapshots: before.attention_correlation_snapshots }).toEqual(before);
    const persisted = await f.rows('SELECT snapshot FROM attention_correlation_snapshots');
    const second = await request(); expect(second.body.items).toEqual(response.body.items); expect(second.body.version).toBe(2);
    expect((await f.rows('SELECT snapshot FROM attention_correlation_snapshots WHERE version=1'))[0]).toEqual(persisted[0]);
  });
  it('late events append snapshots while exact older replay and group IDs remain stable', async () => {
    const b = await emit(101, 60), first = await request(); const a = await emit(101, 5), second = await request();
    expect(second.body.id).toBe(first.body.id); expect(second.body.version).toBe(2);
    expect(second.body.items[0].id).toBe(first.body.items[0].id); expect(second.body.items[0].eventIds.sort()).toEqual([a, b].sort());
    const replay = await get(first.body.id, '?version=1'); expect(replay.body.items[0].eventIds).toEqual([b]);
  });
  it('never acknowledges a new snapshot when commit fails and preserves source rows', async () => {
    await emit(); const delivered = vi.fn(), before = await counts();
    const pool = new Proxy(f.pool, { get(target, name) {
      if (name === 'getConnection') return async () => {
        const connection = await target.getConnection();
        return new Proxy(connection, { get(c, key) {
          if (key === 'commit') return async () => { throw new Error('injected precommit failure'); };
          const value = Reflect.get(c, key); return typeof value === 'function' ? value.bind(c) : value;
        } });
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const isolated = new AttentionStore(() => pool, f.contexts, evidence, signatures,
      () => ({ ...operationsFlags({}), attention: true, context: true }), () => new Date(now));
    await expect(isolated.compute(actor, input(), delivered)).rejects.toThrow('injected precommit failure');
    expect(delivered).not.toHaveBeenCalled(); expect(await counts()).toEqual(before);
  });
  it('serializes concurrent snapshots and overrides, audits split history, and never silently rejoins new arrivals', async () => {
    const a = await emit(), b = await emit(101, 60), first = await request();
    const override = { expectedVersion: 1, reason: 'Synthetic independent incidents', partitions: [[a], [b]] };
    const responses = await Promise.all([request(`/api/operations/attention/${first.body.id}/overrides`, 'POST', override), request(`/api/operations/attention/${first.body.id}/overrides`, 'POST', override)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await get(first.body.id)).body.items).toHaveLength(2); expect((await get(first.body.id, '?version=1')).body.items).toHaveLength(1);
    await emit(101, 120); const late = await request(); expect(late.body.items).toHaveLength(3);
    const concurrent = await Promise.all([request(), request()]); expect(concurrent.map(r => r.body.version).sort()).toEqual([4, 5]);
    const persisted = await f.rows('SELECT version,snapshot FROM attention_correlation_snapshots ORDER BY version'); expect(persisted).toHaveLength(5);
    const v2 = typeof persisted[1].snapshot === 'string' ? JSON.parse(persisted[1].snapshot) : persisted[1].snapshot;
    expect(v2.override).toMatchObject({ ofVersion: 1, actorId: 101, reason: override.reason });
    const invalid = await request(`/api/operations/attention/${first.body.id}/overrides`, 'POST', { ...override, expectedVersion: 5, partitions: [[a]] }); expect(invalid.status).toBe(422);
  });
  it('manually merges exact event partitions without changing original investigations or owners', async () => {
    const source = await f.seed(), a = await emit(), b = await emit(102, 60);
    await f.rows('UPDATE operational_events SET investigation_id=? WHERE id=?', [source.inv.id, a]);
    const before = await f.rows('SELECT id,owner_id,owner_kind FROM investigations WHERE id=?', [source.inv.id]);
    const initial = await request(); expect(initial.body.items).toHaveLength(2);
    const result = await request(`/api/operations/attention/${initial.body.id}/overrides`, 'POST', { expectedVersion: 1, reason: 'Human association only', partitions: [[a, b]] });
    expect(result.status).toBe(200); expect(result.body.items[0].investigationIds).toEqual([source.inv.id]);
    expect(result.body.items[0].reasons[0].kind).toBe('manual'); expect(await f.rows('SELECT id,owner_id,owner_kind FROM investigations WHERE id=?', [source.inv.id])).toEqual(before);
  });
  it('filters investigation membership and complete investigation scope before correlation/count/order', async () => {
    const source = await f.seed(), hidden = await emit(101, 5), visible = await emit(101, 60);
    await f.rows('UPDATE operational_events SET investigation_id=? WHERE id=?', [source.inv.id, hidden]);
    await f.rows('UPDATE investigations SET owner_id=103 WHERE id=?', [source.inv.id]);
    const result = await request(); expect(result.body.items[0].eventIds).toEqual([visible]);
    expect(JSON.stringify(result.body)).not.toContain(hidden); expect(JSON.stringify(result.body)).not.toContain(source.inv.id);
    await f.rows('UPDATE investigations SET owner_id=101 WHERE id=?', [source.inv.id]);
    const full = await request(); expect(full.body.items[0].eventIds).toHaveLength(2);
    await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');
    const retained = await get(full.body.id); expect(retained.status).toBe(200); expect(retained.body.authorizedCounts.total).toBe(0);
  });
  it('filters hidden resources, uses frozen versions and stable IDs, rejects cursors on permission changes', async () => {
    await emit(); await emit(102); await emit(104); const initial = await request(undefined, 'POST', input([101, 102, 104]));
    const first = await get(initial.body.id, '?version=1&limit=1'); expect(first.body.authorizedCounts.total).toBe(3);
    await emit(101, 60); await request(undefined, 'POST', input([101, 102, 104]));
    const second = await get(initial.body.id, `?version=1&limit=1&cursor=${first.body.nextCursor}`);
    expect(second.status).toBe(200); expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=104');
    const staleCursor = await get(initial.body.id, `?version=1&limit=1&cursor=${first.body.nextCursor}`); expect(staleCursor.status).toBe(409);
    const filtered = await get(initial.body.id, '?version=1'); expect(filtered.body.authorizedCounts.total).toBe(2);
    expect(JSON.stringify(filtered.body)).not.toContain('"id":104');
    expect((await request(undefined, 'POST', input([101, 102, 104]))).status).toBe(404);
    const delegated = { ...actor, resourceBoundary: { instanceIds: [101], serverIds: [], networkDeviceIds: [] } };
    expect((await store.read(delegated, initial.body.id)).authorizedCounts.total).toBe(1);
  });
  it.each(['unavailable', 'withdrawn'])('rechecks authoritative P02 proof state %s and masks obsolete fact paths', async state => {
    await emit(); await emit(102); await relation(); const initial = await request();
    expect(initial.body.items).toHaveLength(1); expect(initial.body.items[0].reasons[0].kind).toBe('relation_path');
    await f.rows('UPDATE p05_fixture_proof SET state=?', [state]);
    const cached = await get(initial.body.id); expect(cached.body.items[0]).toMatchObject({ currentValidity: 'unknown', reasons: [] });
    expect((await request()).body.items).toHaveLength(2);
  });
  it('P02 legacy lifecycle is current, including changes during proof IO and time expiry', async () => {
    await emit(); await emit(102); const value = await relation(true); const initial = await request(); expect(initial.body.items).toHaveLength(1);
    onEvidence = async session => { await session.connection.execute('UPDATE resource_relations SET valid_until=? WHERE id=?', [new Date(now - 1), value.relationId]); };
    const invalid = await get(initial.body.id); expect(invalid.body.items[0].reasons).toEqual([]); onEvidence = undefined;
    expect((await request()).body.items).toHaveLength(2);
  });
  it('hides historical relation paths through an intermediate resource after its permission is revoked', async () => {
    await emit(); await emit(102);
    for (const [source, target] of [[101, 104], [104, 102]]) {
      const proposed = await relations.suggest(actor, { source: ref(source), target: ref(target), relationType: 'depends_on', origin: 'manual',
        observedAt: new Date(now - 60_000).toISOString(), validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 120_000).toISOString(),
        evidence: [{ id: 'synthetic-proof', version: 1, hash: 'a'.repeat(64), validUntil: new Date(now + 120_000).toISOString() }] });
      await relations.transition(actor, proposed.relationId, { expectedVersion: proposed.version, action: 'confirm' });
    }
    const initial = await request(); expect(initial.body.items).toHaveLength(1); expect(initial.body.items[0].recordedReasons[0].relationIds).toHaveLength(2);
    await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=104');
    const hidden = await get(initial.body.id); expect(hidden.body.items[0]).toMatchObject({ currentValidity: 'unknown', reasons: [], recordedReasons: [] });
    for (const id of initial.body.items[0].recordedReasons[0].relationIds) expect(JSON.stringify(hidden.body)).not.toContain(id);
    expect((await request()).body.items).toHaveLength(2);
  });
  it('accepts valid original event timestamps without fractional milliseconds', async () => {
    const a = await emit(101, 5, { occurredAt: new Date(Date.parse(from()) + 5000).toISOString().replace('.000Z', 'Z') });
    const response = await request(); expect(response.body.items[0].eventIds).toEqual([a]);
  });
  it('checks relation proof expiry on cached snapshots and keeps the saved explanation score', async () => {
    await emit(); await emit(102, 60); await relation(); const observed = input(), initial = await request();
    now += 120_001;
    const cached = await get(initial.body.id);
    expect(cached.body.items[0]).toMatchObject({ currentValidity: 'unknown', reasons: [], recordedScore: initial.body.items[0].recordedScore });
    expect(cached.body.items[0].score.components.persistence).toBeNull();
    expect(initial.body.items[0].recordedScore.components.persistence).toBeGreaterThan(0);
    expect((await request(undefined, 'POST', observed)).body.items).toHaveLength(2);
  });
  it('revocation during source IO prevents any response content or appended snapshot', async () => {
    await emit(); await emit(102); await relation();
    onEvidence = async session => { await session.connection.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='operations:context:view'"); };
    const response = await request(); expect(response.status).toBe(404); expect(JSON.stringify(response.body)).not.toContain('eventIds');
    expect(Number((await f.rows('SELECT COUNT(*) n FROM attention_correlation_snapshots'))[0].n)).toBe(0);
  });
  it('consumes P04 live qualified synthetic windows and returns unknown on target replacement, never false', async () => {
    await emit();
    const source: BaselineSource = { load: async (_actor, input, fence, targetVersion) => {
      const value = syntheticWindow(input.mode), shift = Math.floor(now / HOUR) * HOUR - Date.parse(value.until);
      const shifted = (at: string) => new Date(Date.parse(at) + shift).toISOString();
      value.from = shifted(value.from); value.until = shifted(value.until);
      for (const bucket of value.buckets) bucket.window = { from: shifted(bucket.window.from), to: shifted(bucket.window.to) };
      value.latest.observedAt = shifted(value.latest.observedAt!); value.identity = { ...value.identity!, resource: input.resource, metric: `${input.metric}@1.0.0`, dimensions: input.dimensions, source: { ...value.identity!.source, version: targetVersion } };
      value.evaluatedAt = new Date(now).toISOString(); value.validUntil = new Date(now + 120_000).toISOString(); value.fence = fence; return value;
    } };
    const baselines = new BaselineStore(() => f.pool, () => source, new OperationsAuthorization(f.contexts), () => ({ ...operationsFlags({}), baselines: true }), () => new Date(now));
    const baseline = await baselines.compute(actor, { ...syntheticInput, resource: ref(101) }); expect(baseline.result.status).toBe('known');
    const initial = await request(); expect(initial.body.items[0].score.components.baseline).not.toBeNull();
    const refs = await f.rows("SELECT member_id,member_version FROM attention_snapshot_members WHERE member_type='baseline'"); expect(refs[0].member_id).toBe(baseline.id);
    await f.rows("UPDATE database_instances SET host='replacement.invalid' WHERE id=101");
    const changed = await get(initial.body.id); expect(changed.body.items[0].score.components.baseline).toBeNull(); expect(changed.body.items[0].missing).toContain('baseline_unknown');
    expect(changed.body.items[0].recordedScore).toEqual(initial.body.items[0].recordedScore);
  });
  it('rejects client scores, future observation requests, unauthorized mutations, and keeps rollback history', async () => {
    await emit(); const initial = await request();
    expect((await request(undefined, 'POST', { ...input(), score: 100, state: 'qualified' })).status).toBe(422);
    expect((await request(undefined, 'POST', { ...input(), observedAt: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(422);
    await f.rows("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='operations:context:manage'");
    const actorNow = await f.contexts.loadActiveActor(101);
    expect((await request(`/api/operations/attention/${initial.body.id}/overrides`, 'POST', { expectedVersion: 1, reason: 'unauthorized', partitions: [initial.body.items[0].eventIds] }, actorNow)).status).toBe(403);
    enabled = false; expect((await request()).body.error).toBe('OPERATIONS_FEATURE_DISABLED');
    const retained = await get(initial.body.id); expect(retained.status).toBe(200); expect(retained.body.items[0].missing).toContain('feature_disabled');
    expect(Number((await f.rows('SELECT COUNT(*) n FROM attention_correlation_snapshots'))[0].n)).toBe(1);
    await f.rows('UPDATE users SET session_version=2 WHERE id=101'); expect((await get(initial.body.id)).status).toBe(401);
  });
  it('applies known signature registry, excludes future events, and marks backlog as historical', async () => {
    signatures[operationsContentHash({ code: 'TIMEOUT', callsite: 'fixture.read', kind: 'failure' })] = 'known-timeout/1';
    const a = await emit(), b = await emit(102, 60); const result = await request(); expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0].reasons[0].kind).toBe('known_signature');
    const raw = await f.rows('SELECT envelope FROM operational_events WHERE id=?', [a]);
    const envelope = typeof raw[0].envelope === 'string' ? JSON.parse(raw[0].envelope) : raw[0].envelope;
    await f.rows('UPDATE operational_events SET occurred_at=?,envelope=? WHERE id=?', [new Date(Date.now() + 3600_000), JSON.stringify({ ...envelope, occurredAt: new Date(Date.now() + 3600_000).toISOString() }), a]);
    expect((await get(result.body.id)).body.authorizedCounts.total).toBe(0);
    now += 2 * 3600_000;
    const backlog = await store.compute(actor, { observedAt: envelope.occurredAt, resources: [ref(102)] });
    expect(backlog.items[0]).toMatchObject({ eventIds: [b], currentValidity: 'unknown' }); expect(backlog.items[0].missing).toContain('historical_observation_window');
    if (process.env.P05_REPORT) writeFileSync(process.env.P05_REPORT, JSON.stringify({ acceptance: 'B08', storage: `real isolated MySQL ${(await f.rows('SELECT VERSION() version'))[0].version}`, transport: 'real JWT/listening HTTP', domainInputs: 'synthetic', modelCalls: 0, realObservationDays: 0, counts: await counts() }, null, 2));
  });
});
