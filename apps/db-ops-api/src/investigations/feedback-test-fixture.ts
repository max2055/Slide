import { randomUUID } from 'node:crypto';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { AgentRunService } from '../adapter/agent-run-service.js';
import { InvestigationResultStore } from './result-schema.js';
import { InvestigationEvidenceStore } from './evidence-store.js';
import { InvestigationFeedbackStore } from './feedback.js';
import { registerInvestigationFeedbackRoutes } from './feedback-routes.js';

/** Only the fixture supplies synthetic evidence/terminal facts. Persistence,
 * migrations, actor grants, JWT and HTTP use the actual production modules.
 * No provider, worker, external target or production DB is contacted. */
export async function startFeedbackFixture(port: number) {
  if (!port) throw new Error('T11_TEST_MYSQL_PORT required; use an isolated MySQL fixture');
  const database = `t11_feedback_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  const config = { host: '127.0.0.1', port, user: 'root', password: process.env.T11_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
  const admin = mysql.createPool(config);
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = mysql.createPool({ ...config, database, connectionLimit: 12 });
  const rows = async (sql: string, values: any[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
  const app = Fastify();
  const close = async () => {
    await app.close(); await pool.end();
    if (!/^t11_feedback_\d+_[a-f0-9]+$/.test(database)) throw new Error('UNSAFE_SCHEMA');
    await admin.query(`DROP DATABASE ${database}`); await admin.end();
  };
  try {
    await new MigrationRunner(pool).run();
    await new MigrationRunner(pool).run();
    await rows("INSERT INTO users (id,username,password_hash) VALUES (101,'t11-owner','no-login'),(102,'t11-viewer','no-login'),(103,'t11-operator','no-login')");
    await rows("INSERT INTO roles (id,name) VALUES (101,'t11-readonly')");
    await rows("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')");
    await rows('INSERT INTO user_roles (user_id,role_id) VALUES (101,101),(102,101),(103,101)');
    await rows("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (101,'fixture','fixture.invalid',3306,'fixture','unused'),(102,'related','fixture.invalid',3306,'fixture','unused')");
    await rows("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only'),(101,102,'read-only'),(102,101,'read-only'),(102,102,'read-only'),(103,101,'read-only'),(103,102,'read-only')");
    const contexts = new ActorContextService(() => pool as never);
    const owner = await contexts.loadActiveActor(101), viewer = await contexts.loadActiveActor(102), operator = await contexts.loadActiveActor(103);
    const authorization = new InvestigationAuthorization(contexts);
    const bridge = new InvestigationSessionBridge(() => pool, authorization);
    const results = new InvestigationResultStore(() => pool, authorization);
    const evidence = new InvestigationEvidenceStore(() => pool, authorization);
    const feedback = new InvestigationFeedbackStore(() => pool, authorization);
    await registerInvestigationFeedbackRoutes(app, createVerifyToken(secret, contexts), feedback);
    const seed = async () => {
      const created = await bridge.create(owner, { idempotencyKey: randomUUID(), title: 'Feedback test', goal: 'Readonly inspection', profileId: 'ops', profileVersion: 1,
        resources: [{ type: 'instance', id: 101, role: 'primary' }, { type: 'instance', id: 102, role: 'related' }],
        context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } } }, { message: 'Inspect', idempotencyKey: randomUUID() });
      const inv = created.investigation, accepted = created.acceptance!;
      await rows("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,102,'viewer',101),(?,103,'operator',101)", [inv.id, inv.id]);
      const [request] = await rows('SELECT message_id FROM investigation_requests WHERE id=?', [accepted.requestId]);
      const { run } = await new AgentRunService(() => pool as never).claim(owner.userId, inv.sessionId, request.message_id, `investigation:${accepted.requestId}`);
      const binding = { investigationId: inv.id, requestId: accepted.requestId, runId: run.id };
      const from = new Date(Date.now() - 60_000).toISOString(), to = new Date(Date.now() - 1000).toISOString();
      const proof = await evidence.put(owner, binding, randomUUID(), { source: 'controlled-observation', summary: 'Synthetic restored metric',
        resources: [{ type: 'instance', id: 101 }, { type: 'instance', id: 102 }], observedFrom: from, observedTo: to, collectedAt: new Date().toISOString(), raw: { status: 'normal' } });
      const value = { schemaVersion: 2 as const, subject: { kind: 'resource' as const, resource: { type: 'instance' as const, id: 101 } }, summary: 'Synthetic execution; no root/recovery verification',
        facts: [{ statement: 'Synthetic metric normal', evidenceIds: [proof.id] }], hypotheses: [], claims: [], rootCauseVerification: { status: 'unverified' as const },
        unresolvedQuestions: ['Requires independent human check'], recommendations: [], problemStatus: 'unconfirmed' as const,
        provenance: { modelVersion: 'not-called', promptVersion: 'fixture', toolVersions: {}, runtimeRunId: run.id, usageStatus: 'unavailable' as const }, createdAt: new Date().toISOString() };
      const result = await results.put(owner, binding, randomUUID(), 0, value);
      // Controlled terminal fixture only; this is not a real model/runtime acceptance.
      await rows("UPDATE agent_runs SET state='completed',finished_at=NOW() WHERE id=?", [run.id]);
      await rows('UPDATE investigations SET active_request_id=NULL WHERE id=?', [inv.id]);
      const [state] = await rows('SELECT version FROM investigations WHERE id=?', [inv.id]);
      const base = { resultId: result.id, resultVersion: result.version, expectedVersion: Number(state.version), note: '人工检查记录' };
      return { inv, binding, proof, result, value, base, verification: { method: '核对合成有界指标', from, to, evidenceIds: [proof.id] } };
    };
    return { app, pool, rows, secret, database, owner, viewer, operator, contexts, authorization, bridge, results, evidence, feedback, seed, close,
      tokens: { owner: signAccessToken(owner, secret), viewer: signAccessToken(viewer, secret), operator: signAccessToken(operator, secret) } };
  } catch (error) { await close(); throw error; }
}
