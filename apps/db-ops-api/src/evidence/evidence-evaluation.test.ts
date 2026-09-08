import { describe, expect, it, vi } from 'vitest';
import { EvidenceEvaluationService } from './evidence-evaluation.js';
import type { ActorContext } from '../auth/actor-context.js';
import { evidenceId } from './evidence-contract.js';
const ref = { type: 'instance' as const, id: 1 };
const actor: ActorContext = { userId: 7, username: 'reader', roles: [], permissions: [], instanceScopes: { 1: 'read-only' }, sessionVersion: 1, requestId: 'req' };
const now = new Date('2026-09-08T10:00:00.000Z');
const content = { schemaVersion: 1 as const, kind: 'observation', status: 'fact' as const, subject: { resource: ref }, quality: 'good' as const, observedAt: now.toISOString(), validUntil: '2026-09-08T10:05:00.000Z', source: 'collector', correlationId: 'req', provenance: 'collector', payload: { metricId: 'cpu', value: 90 } };
const item = { ...content, id: evidenceId(content) };
function fixture() {
  const execute = vi.fn(async (_sql: string, _values?: any[]): Promise<any> => [[], []]);
  const evidence = { getBundle: vi.fn(async () => ({ schemaVersion: 1 as const, resource: ref, generatedAt: now.toISOString(), facts: [item], inferences: [], hypotheses: [], gaps: [], truncated: false })), getItem: vi.fn(async () => item) };
  const operations = { getForActor: vi.fn(async () => ({ id: 'op1', actorId: 7, resource: { type: 'instance', id: '1' }, state: 'succeeded' })) };
  return { execute, evidence, operations, service: new EvidenceEvaluationService(() => ({ execute }), evidence, operations, () => now) };
}
describe('authorized evidence evaluation and decisions', () => {
  it('evaluates persisted versioned constraints and keeps sparse expectations unknown', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce([[{ config_value: JSON.stringify({ schemaVersion: 1, version: 2, rules: [{ id: 'cpu-limit', version: 2, metricId: 'cpu', max: 80 }] }) }], []]);
    const result = await f.service.evaluate(actor, ref);
    expect(result.rulesVersion).toBe(2); expect(result.invariants[0].status).toBe('fail');
    expect(result.expectations[0].status).toBe('unknown');
  });
  it('rejects forbidden resources before querying', async () => {
    const f = fixture();
    await expect(f.service.evaluate(actor, { ...ref, id: 2 })).rejects.toThrow('RESOURCE_FORBIDDEN');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.evidence.getBundle).not.toHaveBeenCalled();
  });
  it('persists only decisions with owned same-resource evidence in the declared window', async () => {
    const f = fixture();
    const input = { statement: 'CPU may be saturated', status: 'hypothesis', evidenceRefs: [item.id], from: now.toISOString(), to: now.toISOString() };
    const decision = await f.service.recordDecision(actor, ref, input);
    expect(decision.status).toBe('hypothesis'); expect(decision.evidenceRefs).toEqual([item.id]);
    expect(f.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO agent_evidence_decisions'), expect.arrayContaining([7, 'instance', 1]));
    f.execute.mockResolvedValueOnce([[{ record_json: JSON.stringify(decision) }], []]);
    expect(await f.service.decision(actor, ref, decision.id)).toEqual(decision);
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('owner_user_id = ? AND resource_type = ? AND resource_id = ?'), [7, 'instance', 1, decision.id]);
    await expect(f.service.recordDecision(actor, ref, { ...input, from: '2026-09-07T10:00:00.000Z', to: '2026-09-07T11:00:00.000Z' })).rejects.toThrow('DECISION_EVIDENCE_INVALID');
    f.evidence.getItem.mockResolvedValueOnce({ ...item, subject: { resource: { ...ref, id: 2 } } });
    await expect(f.service.recordDecision(actor, ref, input)).rejects.toThrow('DECISION_EVIDENCE_INVALID');
    await expect(f.service.recordDecision(actor, ref, { ...input, status: 'fact' })).rejects.toThrow('DECISION_INVALID');
  });
  it('requires admin rules updates and enforces version compare-and-swap', async () => {
    const f = fixture();
    const config = { expectedVersion: 0, rules: [{ id: 'cpu', version: 1, metricId: 'cpu', max: 80 }] };
    await expect(f.service.updateRules(actor, ref, config)).rejects.toThrow('RULES_FORBIDDEN');
    const admin = { ...actor, permissions: ['*'] };
    f.execute.mockResolvedValueOnce([[], []]).mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    expect((await f.service.updateRules(admin, ref, config)).version).toBe(1);
    f.execute.mockResolvedValueOnce([[{ config_value: JSON.stringify({ schemaVersion: 1, version: 1, rules: [] }) }], []]);
    await expect(f.service.updateRules(admin, ref, config)).rejects.toThrow('RULES_VERSION_CONFLICT');
  });
  it('does not equate owned operation success with verified metric recovery', async () => {
    const f = fixture();
    expect(await f.service.recovery(actor, ref, 'op1')).toMatchObject({ status: 'unknown', reason: 'RECOVERY_PLAN_NOT_BOUND', operationState: 'succeeded' });
    expect(f.operations.getForActor).toHaveBeenCalledWith('op1', actor.userId);
    f.operations.getForActor.mockResolvedValueOnce({ id: 'op1', actorId: 8, resource: { type: 'instance', id: '1' }, state: 'succeeded' });
    await expect(f.service.recovery(actor, ref, 'op1')).rejects.toThrow('OPERATION_NOT_FOUND');
  });
  it('rejects concurrent rules updates after their initial version read', async () => {
    const f = fixture();
    const admin = { ...actor, permissions: ['*'] };
    f.execute.mockResolvedValueOnce([[{ config_value: JSON.stringify({ schemaVersion: 1, version: 1, rules: [] }) }], []]).mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    await expect(f.service.updateRules(admin, ref, { expectedVersion: 1, rules: [] })).rejects.toThrow('RULES_VERSION_CONFLICT');
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('BINARY config_value = BINARY ?'), expect.any(Array));
  });
});
