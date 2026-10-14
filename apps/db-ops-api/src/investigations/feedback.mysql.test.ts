import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { startFeedbackFixture } from './feedback-test-fixture.js';
import { InvestigationFeedbackStore } from './feedback.js';
import { provisionInvestigationServiceIdentity } from './authorization.js';
import { MysqlInvestigationStore } from './store.js';

const port = Number(process.env.T11_TEST_MYSQL_PORT);
describe.skipIf(!port)('T11 feedback real MySQL/JWT/HTTP', () => {
  let f: Awaited<ReturnType<typeof startFeedbackFixture>>, s: Awaited<ReturnType<typeof f.seed>>;
  beforeAll(async () => { f = await startFeedbackFixture(port); }, 60_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => { s = await f.seed(); });
  const post = (body: Record<string, unknown>, token?: string, key = randomUUID()) => f.app.inject({ method: 'POST', url: `/api/investigations/${s.inv.id}/feedback`,
    headers: { authorization: `Bearer ${token ?? f.tokens.owner}`, 'idempotency-key': key }, payload: body });
  const get = (token?: string) => f.app.inject({ method: 'GET', url: `/api/investigations/${s.inv.id}/feedback`, headers: { authorization: `Bearer ${token ?? f.tokens.owner}` } });
  const rating = () => ({ ...s.base, kind: 'rating', rating: 'incorrect' });

  it('20 concurrent same-key retries commit one audit/version/event; restart preserves exact response', async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(rating(), f.tokens.owner, key)));
    expect(responses.map(r => r.statusCode)).toEqual(Array(20).fill(200));
    expect(new Set(responses.map(r => r.json().id)).size).toBe(1);
    expect((await f.rows('SELECT * FROM investigation_feedback WHERE investigation_id=?', [s.inv.id])).length).toBe(1);
    expect((await f.rows("SELECT * FROM investigation_stream_events WHERE investigation_id=? AND source_key LIKE 'feedback:%'", [s.inv.id])).length).toBe(1);
    const restarted = new InvestigationFeedbackStore(() => f.pool, f.authorization);
    expect((await restarted.list(f.owner, s.inv.id)).items[0]).toEqual(responses[0].json());
    expect((await post({ ...rating(), note: 'different' }, f.tokens.owner, key)).json().error).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });
  it('different keys on the same investigation version produce one success and one 409', async () => {
    const responses = await Promise.all([post(rating()), post(rating())]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200,409]);
  });
  it('rejects unproven resolved, forged verifier and unobserved recovery without writes', async () => {
    expect((await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved' })).statusCode).toBe(400);
    expect((await post({ ...s.base, kind: 'root_cause', verification: { ...s.verification, verifiedBy: 102 } })).statusCode).toBe(400);
    await f.rows("UPDATE investigation_evidence SET metadata_json=JSON_SET(metadata_json,'$.observedFrom',NULL,'$.observedTo',NULL) WHERE id=?", [s.proof.id]);
    expect((await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved', verification: s.verification })).statusCode).toBe(400);
    expect((await get()).json().items).toEqual([]);
    expect((await f.rows('SELECT version,problem_status,lifecycle FROM investigations WHERE id=?', [s.inv.id]))[0]).toMatchObject({ version: s.base.expectedVersion, problem_status: 'unconfirmed', lifecycle: 'open' });
  });
  it('human root cause and external handling do not resolve service or rewrite result; recovery is independent', async () => {
    const root = await post({ ...s.base, kind: 'root_cause', verification: s.verification }, f.tokens.operator);
    expect(root.statusCode).toBe(200); expect(root.json().verification).toMatchObject({ verifiedBy: 103, status: 'human_confirmed' });
    const recovery = await post({ ...s.base, expectedVersion: root.json().version, kind: 'recovery', verification: s.verification });
    expect(recovery.statusCode).toBe(200);
    const handling = await post({ ...s.base, expectedVersion: recovery.json().version, kind: 'handling', performedAt: s.verification.to, evidenceIds: [], note: '外部处理；password=synthetic-secret' });
    expect(handling.statusCode).toBe(200); expect(handling.body).not.toContain('synthetic-secret');
    expect((await f.results.list(f.owner, s.inv.id)).items[0].result).toEqual(s.result.result);
    expect((await f.rows('SELECT problem_status,lifecycle FROM investigations WHERE id=?', [s.inv.id]))[0]).toMatchObject({ problem_status: 'unconfirmed', lifecycle: 'open' });
  });
  it('verified resolved closure persists human audit and state atomically; not_applicable also allowed', async () => {
    const response = await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved', verification: s.verification });
    expect(response.statusCode).toBe(200); expect(response.json().verification.verifiedBy).toBe(101);
    expect((await f.rows('SELECT lifecycle,problem_status FROM investigations WHERE id=?', [s.inv.id]))[0]).toMatchObject({ lifecycle: 'closed', problem_status: 'resolved' });
    s = await f.seed();
    expect((await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'not_applicable' })).statusCode).toBe(200);
  });
  it('active request blocks close while allowing feedback', async () => {
    await f.rows('UPDATE investigations SET active_request_id=? WHERE id=?', [s.binding.requestId, s.inv.id]);
    expect((await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'not_applicable' })).json().error).toBe('INVESTIGATION_ACTIVE_REQUEST');
    expect((await post(rating())).statusCode).toBe(200);
  });
  it('new result invalidates old feedback references; history preserves exact reviewed version', async () => {
    expect((await post(rating())).statusCode).toBe(200);
    await f.results.put(f.owner, s.binding, randomUUID(), 1, { ...s.value, summary: 'new result' });
    const [state] = await f.rows('SELECT version FROM investigations WHERE id=?', [s.inv.id]);
    expect((await post({ ...rating(), expectedVersion: Number(state.version) })).json().error).toBe('VERSION_CONFLICT');
    expect((await get()).json().items[0]).toMatchObject({ staleResult: true, command: { resultId: s.result.id, resultVersion: 1 } });
  });
  it('explicit reopen clears old recovery; metadata edits preserve it; new admission clears it atomically', async () => {
    const closure = await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved', verification: s.verification });
    expect(closure.statusCode).toBe(200);
    const store = new MysqlInvestigationStore(() => f.pool, f.authorization.forActor(f.owner));
    const actor = { kind: 'user' as const, id: 101 };
    const renamed = await store.patch(actor, s.inv.id, { expectedVersion: closure.json().version, title: 'Retain history' });
    expect(renamed.problemStatus).toBe('resolved');
    const reopened = await store.patch(actor, s.inv.id, { expectedVersion: renamed.version, lifecycle: 'open' });
    expect(reopened.problemStatus).toBe('unconfirmed');
    // Also prove the admission path independently of the reopen transition.
    await f.rows("UPDATE investigations SET problem_status='resolved' WHERE id=?", [s.inv.id]);
    const command = { investigationId: s.inv.id, expectedVersion: reopened.version, message: 'New readonly observation', idempotencyKey: randomUUID() };
    const admitted = await f.bridge.admit(f.owner, command);
    expect((await f.rows('SELECT problem_status,active_request_id,version FROM investigations WHERE id=?', [s.inv.id]))[0])
      .toMatchObject({ problem_status: 'unconfirmed', active_request_id: admitted.requestId, version: admitted.version });
    const [request] = await f.rows('SELECT request_snapshot FROM investigation_requests WHERE id=?', [admitted.requestId]);
    expect(request.request_snapshot.problemStatus).toBe('unconfirmed');
    const replay = await f.bridge.admit(f.owner, command);
    expect(replay).toEqual(admitted);
    expect((await get()).json().items[0].command.resultId).toBe(s.result.id);
    expect((await post({ ...s.base, expectedVersion: admitted.version, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved', verification: s.verification })).statusCode).toBe(409);
  });
  it('expired evidence remains a tombstone in history and cannot be reused for closure', async () => {
    expect((await post({ ...s.base, kind: 'root_cause', verification: s.verification })).statusCode).toBe(200);
    await f.rows('UPDATE investigation_evidence SET expires_at=DATE_SUB(NOW(),INTERVAL 1 DAY) WHERE id=?', [s.proof.id]);
    const history = (await get()).json();
    expect(history.items[0].references[0]).toMatchObject({ status: 'expired', contentHash: s.proof.contentHash });
    expect(JSON.stringify(history)).not.toContain('raw');
    expect((await post({ ...s.base, expectedVersion: history.items[0].version, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved', verification: s.verification })).json().error).toBe('EVIDENCE_EXPIRED');
  });
  it('viewer may read but cannot append feedback; ordinary chat read share grants no access', async () => {
    expect((await post(rating(), f.tokens.viewer)).statusCode).toBe(403);
    expect((await get(f.tokens.viewer)).statusCode).toBe(200);
    await f.rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=102', [s.inv.id]);
    await f.rows("INSERT INTO chat_session_shares (session_id,granted_by,recipient_user_id,permission) VALUES (?,101,102,'read')", [s.inv.sessionId]);
    expect((await get(f.tokens.viewer)).statusCode).toBe(404);
  });
  it('expired membership and revoked related scope reject history and idempotent replay', async () => {
    const key = randomUUID(); expect((await post(rating(), f.tokens.operator, key)).statusCode).toBe(200);
    await f.rows('UPDATE investigation_members SET expires_at=DATE_SUB(NOW(),INTERVAL 1 DAY) WHERE investigation_id=? AND user_id=103', [s.inv.id]);
    expect((await get(f.tokens.operator)).statusCode).toBe(404);
    expect((await post(rating(), f.tokens.operator, key)).statusCode).toBe(404);
    await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');
    expect((await get()).statusCode).toBe(404);
    await f.rows("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,102,'read-only')");
  });
  it('session-version expiry rejects JWT, unauthenticated callers and strict query/body limits', async () => {
    expect((await f.app.inject({ method: 'GET', url: `/api/investigations/${s.inv.id}/feedback` })).statusCode).toBe(401);
    expect((await post({ ...rating(), actorId: 102 })).statusCode).toBe(400);
    await f.rows('UPDATE users SET session_version=session_version+1 WHERE id=102');
    expect((await get(f.tokens.viewer)).statusCode).toBe(401);
    await f.rows('UPDATE users SET session_version=session_version-1 WHERE id=102');
    const response = await f.app.inject({ url: `/api/investigations/${s.inv.id}/feedback?limit=0`, headers: { authorization: `Bearer ${f.tokens.owner}` } });
    expect(response.statusCode).toBe(400); expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it('foreign Run evidence is never accepted as recovery or root-cause proof', async () => {
    const other = await f.seed();
    expect((await post({ ...s.base, kind: 'root_cause', verification: { ...s.verification, evidenceIds: [other.proof.id] } })).statusCode).toBe(404);
  });
  it('proof from only the primary resource cannot resolve all required scopes', async () => {
    await f.rows("UPDATE investigation_evidence SET metadata_json=JSON_SET(metadata_json,'$.resources',CAST(? AS JSON)) WHERE id=?", [JSON.stringify([{ type: 'instance', id: 101 }]), s.proof.id]);
    expect((await post({ ...s.base, kind: 'recovery', verification: s.verification })).statusCode).toBe(400);
    expect((await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved', verification: s.verification })).statusCode).toBe(400);
  });
  it('service identities with live read scopes cannot author human feedback', async () => {
    const c = await f.pool.getConnection();
    let id: number;
    try { id = await provisionInvestigationServiceIdentity(c as never, 't11-test'); } finally { c.release(); }
    await f.rows('INSERT INTO user_roles (user_id,role_id) VALUES (?,101)', [id]);
    await f.rows("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (?,101,'read-only'),(?,102,'read-only')", [id,id]);
    const actor = { ...await f.contexts.loadInvestigationActorFrom(f.pool as never, id, 'service'),
      resourceBoundary: { instanceIds: [101,102], serverIds: [], networkDeviceIds: [] } };
    await f.rows("UPDATE investigations SET owner_kind='service',owner_id=? WHERE id=?", [id,s.inv.id]);
    await expect(f.feedback.add(actor, s.inv.id, randomUUID(), rating())).rejects.toThrow('INVESTIGATION_OPERATION_FORBIDDEN');
    expect(await f.rows('SELECT * FROM investigation_feedback WHERE investigation_id=?', [s.inv.id])).toEqual([]);
  });
  it('failure after audit INSERT rolls back feedback/state/stream as one transaction', async () => {
    await f.rows(`CREATE TRIGGER t11_fail_state BEFORE UPDATE ON investigations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled failure'`);
    try { expect((await post(rating())).statusCode).toBe(503); }
    finally { await f.rows('DROP TRIGGER t11_fail_state'); }
    expect((await get()).json().items).toEqual([]);
    expect((await f.rows('SELECT version FROM investigations WHERE id=?', [s.inv.id]))[0].version).toBe(s.base.expectedVersion);
    expect(await f.rows("SELECT * FROM investigation_stream_events WHERE investigation_id=? AND source_key LIKE 'feedback:%'", [s.inv.id])).toEqual([]);
  });
});
