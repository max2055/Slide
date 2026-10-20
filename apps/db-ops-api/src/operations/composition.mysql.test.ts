/** Synthetic domain records; real formal migrations, MySQL, JWT and listening
 * HTTP through the same composition as server.ts. No target or model calls. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFeedbackFixture } from '../investigations/feedback-test-fixture.js';
import { signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { MigrationRunner } from '../migrations/runner.js';
import { createOperationsComposition } from './composition.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('P10 production composition SQL/HTTP (synthetic inputs)', () => {
  let f: Awaited<ReturnType<typeof startFeedbackFixture>>, base: string;
  let composition: ReturnType<typeof createOperationsComposition>;
  const env: Record<string, string> = { OPERATIONS_CONTEXT_ENABLED: 'true', OPERATIONS_CASES_ENABLED: 'true',
    OPERATIONS_BASELINES_ENABLED: 'true', OPERATIONS_ATTENTION_ENABLED: 'true',
    OPERATIONS_ACTION_PLANS_ENABLED: 'true', OPERATIONS_ACTION_DISPATCH_ENABLED: 'true' };
  let author: ActorContext, reviewer: ActorContext;
  const ref = (id: number) => ({ type: 'instance' as const, id });
  async function request(path: string, method = 'GET', body?: unknown, actor: ActorContext | null = author) {
    const response = await fetch(base + path, { method, headers: {
      ...(actor ? { Authorization: `Bearer ${signAccessToken(actor, f.secret)}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any, cache: response.headers.get('cache-control') };
  }
  beforeAll(async () => {
    process.env.T11_TEST_MYSQL_PASSWORD = process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '';
    f = await startFeedbackFixture(port);
    await dbConnection.initialize({ host: '127.0.0.1', port, user: 'root', password: process.env.T11_TEST_MYSQL_PASSWORD ?? '', database: f.database });
    // Fixture secret is durable within this isolated candidate; never the platform key.
    composition = createOperationsComposition(() => f.pool, { jwtSecret: f.secret, env });
    await composition.register(f.app);
    await f.rows("INSERT INTO roles(id,name) VALUES(301,'p10-author'),(302,'p10-reviewer')");
    await f.rows(`INSERT INTO role_permissions(role_id,permission_id)
      SELECT 301,id FROM permissions WHERE code IN ('chat:view','instance:view','instance:manage','operations:context:view','operations:context:manage','operations:cases:view','operations:cases:manage','operations:cases:review','operations:actions:view','operations:actions:propose')`);
    await f.rows(`INSERT INTO role_permissions(role_id,permission_id)
      SELECT 302,id FROM permissions WHERE code IN ('chat:view','instance:view','instance:manage','operations:context:view','operations:context:manage','operations:cases:view','operations:cases:review')`);
    await f.rows('DELETE FROM user_roles WHERE user_id IN (101,102)');
    await f.rows('INSERT INTO user_roles(user_id,role_id) VALUES(101,301),(102,302)');
    await f.rows("UPDATE instance_permissions SET access_level='read-write' WHERE user_id IN (101,102)");
    author = await f.contexts.loadActiveActor(101); reviewer = await f.contexts.loadActiveActor(102);
    base = await f.app.listen({ host: '127.0.0.1', port: 0 });
  }, 90_000);
  afterAll(async () => { await dbConnection.close(); await f?.close(); });

  it('registers formal ledger idempotently without automatically granting existing roles', async () => {
    await new MigrationRunner(f.pool).run();
    const ledger = await f.rows("SELECT migration_id,status FROM app_schema_migrations WHERE migration_id LIKE '12%operations%' ORDER BY migration_id");
    expect(ledger).toEqual([{ migration_id: '128_operations_foundation.sql', status: 'completed' }, { migration_id: '129_operations_permissions.sql', status: 'completed' }]);
    const grants = await f.rows("SELECT COUNT(*) n FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.code LIKE 'operations:%' AND rp.role_id NOT IN (301,302)");
    expect(Number(grants[0].n)).toBe(0);
  });
  it('uses JWT and live flags; preparation cannot dispatch even if configured true', async () => {
    expect((await request('/api/operations/knowledge', 'GET', undefined, null)).status).toBe(401);
    expect(composition.flags().dispatch).toBe(false);
    expect(composition.actionEnvironmentAvailable).toBe(false);
    expect((await request('/api/operations/actions/execute', 'POST', {})).status).toBe(404);
    env.OPERATIONS_CASES_ENABLED = 'false';
    expect((await request('/api/operations/knowledge', 'POST', {})).status).toBe(422);
    env.OPERATIONS_CASES_ENABLED = 'true';
    expect((await request('/api/operations/knowledge')).body.qualification).toBe('not_qualified');
  });
  it('confirms only exact authorized investigation evidence; expiry removes graph facts', async () => {
    const source = await f.seed();
    const now = new Date(), until = new Date(+now + 60_000).toISOString();
    const [evidence] = await f.rows('SELECT content_hash,expires_at FROM investigation_evidence WHERE id=?', [source.proof.id]);
    const proposed = await request('/api/operations/relations', 'POST', { source: ref(101), target: ref(102), relationType: 'replicates_to', origin: 'manual',
      observedAt: now.toISOString(), validFrom: now.toISOString(), validUntil: until,
      evidence: [{ id: source.proof.id, version: 1, hash: evidence.content_hash, validUntil: until }] });
    expect(proposed.status).toBe(200);
    const id = proposed.body.id;
    const confirmed = await request(`/api/operations/relations/${id}/review`, 'POST', { expectedVersion: 1, action: 'confirm' }, reviewer);
    expect(confirmed.body.state).toBe('confirmed');
    const graph = await request('/api/operations/resources/instance/101/relations?factsOnly=true');
    expect(JSON.stringify(graph.body)).toContain(id);
    await f.rows('UPDATE investigation_evidence SET expired_at=UTC_TIMESTAMP(3) WHERE id=?', [source.proof.id]);
    const invalidated = await request('/api/operations/resources/instance/101/relations?factsOnly=true');
    expect(JSON.stringify(invalidated.body)).not.toContain(id);
    expect((await f.rows('SELECT COUNT(*) n FROM resource_relation_revisions WHERE relation_id=?', [id]))[0].n).toBe(3);
  });
  it('binds case publication to closed exact result and a different real authenticated test actor', async () => {
    const source = await f.seed();
    await f.rows("UPDATE investigations SET lifecycle='closed',problem_status='resolved' WHERE id=?", [source.inv.id]);
    await f.rows("UPDATE investigation_results SET result_json=JSON_SET(result_json,'$.provenance.modelVersion','synthetic-model-v1','$.provenance.promptVersion','synthetic-prompt-v1','$.provenance.toolVersions',JSON_OBJECT('controlled-observation','synthetic-v1')) WHERE id=?", [source.result.id]);
    const candidate = { investigationId: source.inv.id, resultVersion: 1, humanConfirmed: true,
      content: { title: '合成测试案例', symptoms: '合成现象', faultType: 'synthetic', confirmedCause: '合成原因', actions: '未执行目标动作', actualEffect: '合成效果', counterexamples: '不能计真实资格' },
      applicability: { conditions: '隔离测试', productVersion: 'synthetic-v1', resourceVersion: 'synthetic-v1' }, validUntil: new Date(Date.now() + 60_000).toISOString() };
    const created = await request('/api/operations/knowledge', 'POST', candidate);
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(`/api/operations/knowledge/${id}/submit`, 'POST', { expectedRevision: 1 })).status).toBe(200);
    const review = { expectedRevision: 2, version: 1, contentHash: created.body.contentHash, decision: 'approved', note: 'Synthetic HTTP identity separation, not real case qualification' };
    expect((await request(`/api/operations/knowledge/${id}/review`, 'POST', review)).status).toBe(403);
    expect((await request(`/api/operations/knowledge/${id}/review`, 'POST', review, reviewer)).status).toBe(200);
    const visible = await request('/api/operations/knowledge', 'GET', undefined, reviewer);
    expect(visible.body.authorizedCounts.total).toBe(1); expect(visible.cache).toBe('private, no-store');
    await f.rows('DELETE FROM instance_permissions WHERE user_id=102 AND instance_id=102');
    expect((await request('/api/operations/knowledge', 'GET', undefined, reviewer)).body.authorizedCounts.total).toBe(0);
    await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(102,102,'read-write')");
    env.OPERATIONS_CASES_ENABLED = 'false';
    expect((await request(`/api/operations/knowledge/${id}`)).status).toBe(200);
    await new MigrationRunner(f.pool).run();
    expect((await f.rows('SELECT COUNT(*) n FROM trusted_case_reviews WHERE case_id=?', [id]))[0].n).toBe(1);
    env.OPERATIONS_CASES_ENABLED = 'true';
  });
  it('keeps unavailable formal baseline qualification unknown', async () => {
    const result = await request('/api/operations/baselines', 'POST', { resource: ref(101), metric: 'db.uptime_seconds', dimensions: {}, mode: 'daily' });
    expect(result.status).toBe(200);
    expect(result.body.result.status).toBe('unknown');
    expect(result.body.result.comparison).toMatchObject({ value: null, baselineAnomaly: null, deviationRatio: null });
  });
});
