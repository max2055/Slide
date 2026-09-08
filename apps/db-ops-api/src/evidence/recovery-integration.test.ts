import { expect, it, vi } from 'vitest';
import { EvidenceEvaluationService } from './evidence-evaluation.js';
import { createRecoveryBinding } from '../operations/recovery-policy.js';
import { evidenceId } from './evidence-contract.js';
import type { ActorContext } from '../auth/actor-context.js';
vi.mock('../audit/audit-log.js', () => ({ auditLogManager: { logConfigChange: vi.fn(async () => {}) } }));
const ref = { type: 'instance' as const, id: 1 };
const actor: ActorContext = { userId: 7, username: 'admin', roles: [], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: 'r' };
const now = new Date('2026-09-09T00:00:00.000Z');
const policy = { schemaVersion: 1, version: 1, enabled: true, commandTypes: ['write'], metricId: 'cpu', source: 'collector', max: 80, windowSeconds: 60, maxSampleGapSeconds: 30 };
function sample(seconds: number, source = 'collector', value = 10) {
  const content = { schemaVersion: 1 as const, kind: 'observation', status: 'fact' as const, subject: { resource: ref }, quality: 'good' as const, observedAt: new Date(now.getTime() - 60000 + seconds * 1000).toISOString(), validUntil: new Date(now.getTime() - 60000 + (seconds + 31) * 1000).toISOString(), source, correlationId: 'r', provenance: 'collector', payload: { metricId: 'cpu', value } };
  return { ...content, id: evidenceId(content) };
}
function fixture() {
  const execute = vi.fn(async (_sql: string, _values?: any[]): Promise<any> => [[], []]);
  const evidence = { getBundle: vi.fn(async (): Promise<any> => ({ facts: [], gaps: [] })), getItem: vi.fn(async () => null) };
  const operations = { getForActor: vi.fn(async () => ({ id: 'op1', actorId: 7, resource: { type: 'instance', id: '1' }, commandType: 'write', state: 'succeeded', finishedAt: new Date(now.getTime() - 60000) })), recoveryBindingForActor: vi.fn(async (): Promise<unknown> => createRecoveryBinding(policy, actor.userId, ref, 'write')) };
  return { execute, evidence, operations, service: new EvidenceEvaluationService(() => ({ execute }), evidence, operations, () => now) };
}
it('configures opt-in recovery with actor authorization and expected version', async () => {
  const f = fixture();
  expect(await f.service.recoveryPolicy(actor, ref)).toMatchObject({ version: 0, enabled: false });
  const { version, schemaVersion, ...fields } = policy;
  expect(await f.service.updateRecoveryPolicy(actor, ref, { ...fields, expectedVersion: 0 })).toMatchObject({ version: 1, enabled: true });
  f.execute.mockResolvedValueOnce([[{ config_value: JSON.stringify(policy) }], []]);
  await expect(f.service.updateRecoveryPolicy(actor, ref, { ...fields, expectedVersion: 0 })).rejects.toThrow('RECOVERY_POLICY_VERSION_CONFLICT');
  await expect(f.service.updateRecoveryPolicy({ ...actor, permissions: [], instanceScopes: { 1: 'read-only' } }, ref, { ...fields, expectedVersion: 0 })).rejects.toThrow('RECOVERY_POLICY_FORBIDDEN');
});
it('verifies the immutable snapshot using persisted finish time and independent matched-source evidence', async () => {
  const f = fixture();
  f.execute.mockResolvedValueOnce([[0, 30, 60].map(seconds => ({ evidence_json: sample(seconds) })), []]);
  const result = await f.service.recovery(actor, ref, 'op1');
  expect(result).toMatchObject({ status: 'recovered', policyVersion: 1, startedAt: new Date(now.getTime() - 60000).toISOString() });
  expect(f.evidence.getBundle).toHaveBeenCalledWith(actor, ref);
  expect(f.operations.recoveryBindingForActor).toHaveBeenCalledWith('op1', 7);
  f.execute.mockResolvedValueOnce([[0, 30, 60].map(seconds => ({ evidence_json: sample(seconds, 'untrusted') })), []]);
  expect((await f.service.recovery(actor, ref, 'op1')).status).toBe('unknown');
});
it('keeps missing snapshots, actor mismatches and expired interiors unknown', async () => {
  const f = fixture();
  f.operations.recoveryBindingForActor.mockResolvedValueOnce(null);
  expect(await f.service.recovery(actor, ref, 'op1')).toMatchObject({ status: 'unknown', reason: 'RECOVERY_PLAN_NOT_BOUND' });
  expect(f.evidence.getBundle).not.toHaveBeenCalled();
  f.operations.recoveryBindingForActor.mockResolvedValueOnce(createRecoveryBinding(policy, 8, ref, 'write'));
  expect((await f.service.recovery(actor, ref, 'op1')).status).toBe('unknown');
  const { id, ...content } = sample(0); const expired = { ...content, validUntil: new Date(now.getTime() - 55000).toISOString() };
  f.execute.mockResolvedValueOnce([[{ evidence_json: { ...expired, id: evidenceId(expired) } }, { evidence_json: sample(30) }, { evidence_json: sample(60) }], []]);
  expect(await f.service.recovery(actor, ref, 'op1')).toMatchObject({ status: 'unknown', reason: 'RECOVERY_EVIDENCE_GAP' });
});
