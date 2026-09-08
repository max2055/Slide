import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { EvidenceStore } from '../../apps/db-ops-api/src/evidence/evidence-store.js';
import { evidenceId, type EvidenceItem } from '../../apps/db-ops-api/src/evidence/evidence-contract.js';
import { EvidenceEvaluationService } from '../../apps/db-ops-api/src/evidence/evidence-evaluation.js';
import { PersistentOperationService } from '../../apps/db-ops-api/src/operations/operation-service.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';

if (process.env.DB_HOST !== '127.0.0.1' || !/^slide_evidence_test_v[0-9]+$/.test(process.env.DB_NAME ?? '')) throw new Error('ISOLATED_EVIDENCE_DATABASE_REQUIRED');
assert(await dbConnection.initialize());
const pool = dbConnection.getPool()!;
try {
  const [users] = await pool.query<any[]>("SELECT id FROM users WHERE username = 'evidence-qualification'");
  const [resources] = await pool.query<any[]>("SELECT id FROM servers WHERE label = 'evidence-qualification' AND collection_enabled = 0");
  assert(users[0] && resources[0], 'Run evidence-persistence seed first');
  const actor: ActorContext = { userId: users[0].id, username: 'evidence-qualification', roles: ['admin'], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: randomUUID() };
  const resource = { type: 'server' as const, id: resources[0].id };
  const evaluation = new EvidenceEvaluationService();
  const operations = new PersistentOperationService(() => pool as any);
  const store = new EvidenceStore();
  const previous = await evaluation.recoveryPolicy(actor, resource);
  const fields = { enabled: true, commandTypes: ['qualification-metadata-only'], metricId: 'qualification_health', source: `qualification:${randomUUID()}`, min: 0, max: 1, windowSeconds: 30, maxSampleGapSeconds: 12 };
  const policy = await evaluation.updateRecoveryPolicy(actor, resource, { ...fields, expectedVersion: previous.version });
  const input = { actorId: actor.userId, origin: 'qualification', resource: { ...resource, id: String(resource.id) }, commandType: fields.commandTypes[0], risk: 'low' as const, idempotencyKey: randomUUID(), correlationId: actor.requestId };
  // This service only persists metadata; no executor or operational command is invoked.
  const operation = await operations.create(input);
  const binding = await operations.recoveryBindingForActor(operation.id, actor.userId);
  assert.equal((binding as any).policyVersion, policy.version);
  await evaluation.updateRecoveryPolicy(actor, resource, { ...fields, enabled: false, expectedVersion: policy.version });
  assert.equal((await operations.create(input)).id, operation.id);
  assert.deepEqual(await operations.recoveryBindingForActor(operation.id, actor.userId), binding);
  await assert.rejects(evaluation.recovery({ ...actor, userId: actor.userId + 100000 }, resource, operation.id), /OPERATION_NOT_FOUND/);
  await operations.transition(operation.id, 'claimed', 'QUALIFICATION', actor.userId);
  await operations.transition(operation.id, 'running', 'QUALIFICATION', actor.userId);
  const finished = await operations.transition(operation.id, 'succeeded', 'QUALIFICATION_METADATA_ONLY', actor.userId);
  assert(finished.finishedAt);
  assert.equal((await evaluation.recovery(actor, resource, operation.id)).status, 'unknown');
  let firstObserved = 0;
  for (let index = 0; index < 3; index++) {
    if (index) await delay(10_000);
    const observedAt = new Date().toISOString();
    if (!index) firstObserved = Date.parse(observedAt);
    const content: Omit<EvidenceItem, 'id'> = { schemaVersion: 1, kind: 'observation', status: 'fact', subject: { resource }, quality: 'good', observedAt, validUntil: new Date(Date.parse(observedAt) + 15_000).toISOString(), source: fields.source, correlationId: actor.requestId, provenance: 'isolated qualification fixture, not hardware UAT', payload: { metricId: fields.metricId, value: 1 } };
    await store.put(actor, { ...content, id: evidenceId(content) });
  }
  assert.equal((await evaluation.recovery(actor, resource, operation.id)).status, 'unknown');
  await delay(Math.max(0, firstObserved + 30_100 - Date.now()));
  const result = await evaluation.recovery(actor, resource, operation.id);
  assert.equal(result.status, 'recovered');
  assert.equal(result.policyVersion, policy.version);
  assert.equal(result.evidenceRefs.length, 3);
  console.log(JSON.stringify({ status: 'passed', database: process.env.DB_NAME, operationId: operation.id, checks: ['immutable-policy', 'idempotency', 'ownership', 'incomplete-window', 'continuous-observations'], hardwareUat: false }));
} finally { await dbConnection.close(); }
