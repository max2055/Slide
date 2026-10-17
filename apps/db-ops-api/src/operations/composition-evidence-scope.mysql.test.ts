/** P10-R1: synthetic evidence and historical rows; real migrations/MySQL/JWT/HTTP.
 * No target, Provider, human approval or dispatch. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFeedbackFixture } from '../investigations/feedback-test-fixture.js';
import { signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { createOperationsComposition } from './composition.js';
import { InvestigationRelationEvidence } from './actions/plan-store.js';
import { MysqlRelationStore, relationHash } from './relations/store.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('P10-R1 evidence support versus complete authorization scope', () => {
  let f: Awaited<ReturnType<typeof startFeedbackFixture>>, base: string, actor: ActorContext;
  const ref = (id: number) => ({ type: 'instance' as const, id });
  beforeAll(async () => {
    process.env.T11_TEST_MYSQL_PASSWORD = process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? '';
    f = await startFeedbackFixture(port);
    await f.rows("INSERT INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('instance:manage','operations:context:manage','operations:context:view')");
    await f.rows("UPDATE instance_permissions SET access_level='read-write' WHERE user_id=101");
    actor = await f.contexts.loadActiveActor(101);
    const composition = createOperationsComposition(() => f.pool, { jwtSecret: f.secret,
      env: { OPERATIONS_CONTEXT_ENABLED: 'true', OPERATIONS_ATTENTION_ENABLED: 'true', OPERATIONS_ACTION_DISPATCH_ENABLED: 'true' } });
    expect(composition.flags().dispatch).toBe(false);
    await composition.register(f.app); base = await f.app.listen({ host: '127.0.0.1', port: 0 });
  }, 90_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => { await f.rows('DELETE FROM resource_relation_revisions'); });
  async function http(path: string, body?: unknown) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${signAccessToken(actor, f.secret)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as any };
  }
  async function proofFor(ids = [101, 102]) {
    const source = await f.seed();
    const proof = await f.evidence.put(actor, source.binding, randomUUID(), {
      source: 'controlled-observation', summary: 'Synthetic observation limited to declared evidence resources',
      resources: ids.map(ref), observedFrom: new Date(Date.now()-60_000).toISOString(), observedTo: new Date(Date.now()-1000).toISOString(),
      collectedAt: new Date().toISOString(), raw: { observedResources: ids } });
    const [row] = await f.rows('SELECT content_hash,metadata_json FROM investigation_evidence WHERE id=?', [proof.id]);
    const metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
    expect(metadata.resources).toEqual(ids.map(ref));
    return { ...source, proof, evidence: { id: proof.id, version: 1, hash: row.content_hash as string,
      validUntil: new Date(Date.now() + 120_000).toISOString() } };
  }
  async function propose(evidence: Awaited<ReturnType<typeof proofFor>>['evidence'][]) {
    const now = new Date();
    const response = await http('/api/operations/relations', { source: ref(101), target: ref(102), relationType: 'replicates_to', origin: 'manual',
      observedAt: now.toISOString(), validFrom: now.toISOString(), validUntil: new Date(+now + 120_000).toISOString(), evidence });
    expect(response.status).toBe(200); return response.body;
  }
  const confirm = (id: string) => http(`/api/operations/relations/${id}/review`, { expectedVersion: 1, action: 'confirm' });
  const graph = () => http('/api/operations/resources/instance/101/relations?factsOnly=true');
  // Reproduce persisted confirmations produced by the old bug, without an allow
  // resolver in production. Append the exact hashed revision in this fixture only.
  async function oldConfirmation(value: any) {
    await new MysqlRelationStore(() => f.pool).transaction(async session => {
      const current = (await session.head(value.id))!;
      const confirmed = { ...current, state: 'confirmed' as const, version: 2, confirmedBy: actor.userId, confirmedAt: new Date().toISOString() };
      confirmed.contentHash = relationHash(confirmed); await session.append(confirmed);
    });
  }
  it('preserves complete resolver ACL scope while exposing only the evidence resources as support', async () => {
    const source = await proofFor([101]);
    const c = await f.pool.getConnection();
    try {
      await c.beginTransaction();
      const proof = await new InvestigationRelationEvidence(f.authorization).lock(c as never, actor, source.evidence);
      expect(proof!.resources).toEqual(expect.arrayContaining([ref(101), ref(102)]));
      expect(proof).toHaveProperty('evidenceResources', [ref(101)]);
      await c.commit();
    } finally { await c.rollback(); c.release(); }
  });
  it('accepts complete evidence as a graph fact and Attention source', async () => {
    const source = await proofFor(), value = await propose([source.evidence]);
    const result = await confirm(value.id); expect(result.status).toBe(200); expect(result.body.state).toBe('confirmed');
    expect((await graph()).body.edges.map((e: any) => e.relationId)).toContain(value.id);
    const attention = await http('/api/operations/attention', { observedAt: new Date(Date.now()-1000).toISOString(), resources: [ref(101), ref(102)] });
    expect(attention.status).toBe(200);
    const [row] = await f.rows('SELECT snapshot FROM attention_correlation_snapshots WHERE id=? AND version=?', [attention.body.id, attention.body.version]);
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    expect(snapshot.edges.map((e: any) => e.id)).toContain(value.id);
  });
  it.each([[101], [102]])('rejects incomplete proof %j even with both endpoints in the authorized investigation', async id => {
    const source = await proofFor([id]), value = await propose([source.evidence]);
    expect((await confirm(value.id)).status).toBe(422);
    expect((await graph()).body.edges.map((e: any) => e.relationId)).not.toContain(value.id);
  });
  it('does not pool incomplete proofs or let an unrelated proof inherit another proof support', async () => {
    const a = await proofFor([101]), b = await proofFor([102]), complete = await proofFor();
    for (const evidence of [[a.evidence, b.evidence], [complete.evidence, a.evidence]]) {
      const value = await propose(evidence); expect((await confirm(value.id)).status).toBe(422);
    }
  });
  it.each(['graph', 'attention'])('removes a previously confirmed unsupported fact from %s consumption', async consumer => {
    const source = await proofFor([101]), value = await propose([source.evidence]);
    await oldConfirmation(value);
    if (consumer === 'graph') {
      expect((await graph()).body.edges.map((e: any) => e.relationId)).not.toContain(value.id);
    } else {
      const response = await http('/api/operations/attention', { observedAt: new Date(Date.now()-1000).toISOString(), resources: [ref(101), ref(102)] });
      expect(response.status).toBe(200);
      const [row] = await f.rows('SELECT snapshot FROM attention_correlation_snapshots WHERE id=? AND version=?', [response.body.id, response.body.version]);
      const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
      expect(snapshot.edges.map((e: any) => e.id)).not.toContain(value.id);
      expect(response.body.items.flatMap((g: any) => g.reasons.flatMap((r: any) => r.relationIds))).not.toContain(value.id);
    }
    expect((await f.rows('SELECT state FROM resource_relation_revisions WHERE relation_id=? ORDER BY version DESC LIMIT 1', [value.id]))[0].state).toBe('withdrawn');
  });
  it('rejects live revocation of an investigation-only resource even when proof covers both endpoints', async () => {
    const source = await proofFor(), value = await propose([source.evidence]);
    await f.rows("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(104,'extra','fixture.invalid',3306,'fixture','unused')");
    await f.rows("INSERT INTO investigation_resources(investigation_id,resource_type,resource_id,role) VALUES(?,'instance',104,'related')", [source.inv.id]);
    await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,104,'read-write')");
    actor = await f.contexts.loadActiveActor(101);
    await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=104');
    const c = await f.pool.getConnection();
    try { await expect(new InvestigationRelationEvidence(f.authorization).lock(c as never, actor, source.evidence)).rejects.toMatchObject({ statusCode: 404 }); }
    finally { c.release(); }
    expect((await confirm(value.id)).status).toBe(503);
    expect((await graph()).body.edges.map((e: any) => e.relationId)).not.toContain(value.id);
  });
  it.each(['expiry', 'invalidation', 'archive'])('rechecks %s before graph and Attention delivery', async kind => {
    const source = await proofFor(), value = await propose([source.evidence]);
    expect((await confirm(value.id)).status).toBe(200);
    if (kind === 'expiry') await f.rows('UPDATE investigation_evidence SET expires_at=UTC_TIMESTAMP(3) WHERE id=?', [source.proof.id]);
    if (kind === 'invalidation') await f.rows('UPDATE investigation_evidence SET expired_at=UTC_TIMESTAMP(3) WHERE id=?', [source.proof.id]);
    if (kind === 'archive') await f.rows("UPDATE investigations SET lifecycle='archived' WHERE id=?", [source.inv.id]);
    const response = await http('/api/operations/attention', { observedAt: new Date(Date.now()-1000).toISOString(), resources: [ref(101), ref(102)] });
    expect(response.status).toBe(200);
    const [row] = await f.rows('SELECT snapshot FROM attention_correlation_snapshots WHERE id=? AND version=?', [response.body.id, response.body.version]);
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    expect(snapshot.edges.map((e: any) => e.id)).not.toContain(value.id);
    expect((await graph()).body.edges.map((e: any) => e.relationId)).not.toContain(value.id);
  });
  it.each(['hash', 'version', 'missing', 'expired', 'archived'])('rejects %s evidence without weakening scope checks', async kind => {
    const source = await proofFor(), evidence = { ...source.evidence };
    if (kind === 'hash') evidence.hash = '0'.repeat(64);
    if (kind === 'version') evidence.version = 2;
    if (kind === 'missing') evidence.id = randomUUID();
    if (kind === 'expired') await f.rows('UPDATE investigation_evidence SET expired_at=UTC_TIMESTAMP(3) WHERE id=?', [evidence.id]);
    if (kind === 'archived') await f.rows("UPDATE investigations SET lifecycle='archived' WHERE id=?", [source.inv.id]);
    const value = await propose([evidence]);
    expect((await confirm(value.id)).status).toBe(kind === 'missing' ? 503 : 422);
    expect((await graph()).body.edges.map((e: any) => e.relationId)).not.toContain(value.id);
  });
});
