import { describe, expect, it, vi } from 'vitest';
import { EvidenceEvaluationService } from './evidence-evaluation.js';
import type { ActorContext } from '../auth/actor-context.js';
import { evidenceId } from './evidence-contract.js';
import { auditLogManager } from '../audit/audit-log.js';
vi.mock('../audit/audit-log.js', () => ({ auditLogManager: { logConfigChange: vi.fn(async () => {}) } }));
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
  it('uses per-metric durable histories beyond the global100 rows and deduplicates repeated reads', async () => {
    const f = fixture();
    const current = Array.from({ length: 7 }, (_, i) => { const value = { ...content, payload: { metricId: `metric_${i}`, value: 90 } }; return { ...value, id: evidenceId(value) }; });
    const history = current.flatMap(row => Array.from({ length: 21 }, (_, i) => [0, 1].map(repeat => {
      const { id, ...value } = row;
      const prior = { ...value, correlationId: `read_${repeat}`, observedAt: new Date(now.getTime() - (i + 1) * 60000).toISOString() };
      return { ...prior, id: evidenceId(prior) };
    })).flat());
    expect(history.length).toBeGreaterThan(100);
    f.evidence.getBundle.mockResolvedValueOnce({ schemaVersion: 1, resource: ref, generatedAt: now.toISOString(), facts: current, inferences: [], hypotheses: [], gaps: [], truncated: false });
    f.execute.mockImplementation(async (sql, values) => sql.includes('SELECT evidence_json') ? [history.filter(row => row.payload.metricId === values![5]).map(row => ({ evidence_json: row })), []] : [[], []]);
    const result = await f.service.evaluate(actor, ref);
    expect(result.expectations).toHaveLength(7);
    expect(result.expectations.every(value => value.sampleCount === 21 && value.status === 'within-range')).toBe(true);
    expect(f.execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT 2001'), expect.arrayContaining([actor.userId, ref.type, ref.id]));
  });
  it('supports admin:* rules permission and audits the changed configuration', async () => {
    const f = fixture();
    const config = await f.service.updateRules({ ...actor, permissions: ['admin:*'] }, ref, { expectedVersion: 0, rules: [] });
    expect(config.version).toBe(1);
    expect(auditLogManager.logConfigChange).toHaveBeenCalledWith(expect.objectContaining({ userId: '7', configKey: 'evidence_invariants:instance:1', newValue: config }));
  });
  it('reports bounded history truncation without inflating repeated samples', async () => {
    const f = fixture();
    const old = { ...content, observedAt: new Date(now.getTime() - 60000).toISOString() };
    const rows = Array.from({ length: 2001 }, (_, i) => { const value = { ...old, correlationId: `read_${i}` }; return { evidence_json: { ...value, id: evidenceId(value) } }; });
    f.execute.mockImplementation(async sql => sql.includes('SELECT evidence_json') ? [rows, []] : [[], []]);
    const result = await f.service.evaluate(actor, ref);
    expect(result.expectations[0].sampleCount).toBe(1);
    expect(result.expectations[0].status).toBe('unknown');
    expect(result.gaps).toContain('EXPECTATION_HISTORY_TRUNCATED');
  });
  it('lists bounded owner/resource decisions and excludes records with missing evidence', async () => {
    const f = fixture();
    const input = { statement: 'CPU may be saturated', status: 'hypothesis', evidenceRefs: [item.id], from: now.toISOString(), to: now.toISOString() };
    const decision = await f.service.recordDecision(actor, ref, input);
    f.execute.mockResolvedValueOnce([[{ record_json: decision }], []]);
    expect((await f.service.decisions(actor, ref, 10)).items).toEqual([decision]);
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT 11'), [actor.userId, ref.type, ref.id]);
    f.execute.mockResolvedValueOnce([[{ record_json: decision }], []]);
    f.evidence.getItem.mockResolvedValueOnce(null as any);
    const missing = await f.service.decisions(actor, ref, 10);
    expect(missing.items).toEqual([]); expect(missing.gaps).toContain('DECISION_EVIDENCE_UNAVAILABLE');
    await expect(f.service.decisions(actor, ref, 51)).rejects.toThrow('DECISION_INVALID');
  });
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
