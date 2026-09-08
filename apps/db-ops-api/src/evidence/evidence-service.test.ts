import { describe, expect, it, vi } from 'vitest';
import { EvidenceService } from './evidence-service.js';
import { EvidenceStore } from './evidence-store.js';
import type { ActorContext } from '../auth/actor-context.js';
import { evidenceId } from './evidence-contract.js';
const actor: ActorContext = { userId: 7, username: 'reader', roles: [], permissions: [], instanceScopes: { 1: 'read-only' }, sessionVersion: 1, requestId: 'req' };
const ref = { type: 'instance' as const, id: 1 };
const now = new Date('2026-09-08T00:10:00.000Z');
function fixture() {
  const execute = vi.fn(async () => [[], []]);
  const store = new EvidenceStore(() => ({ execute }));
  const observations = vi.fn(async () => [{ resource: ref, metricId: 'cpu_usage', value: 1, source: 'metrics_history', quality: 'good' as const, observedAt: new Date('2026-09-08T00:00:00.000Z'), validUntil: new Date('2026-09-08T00:05:00.000Z') }]);
  const service = new EvidenceService(store, observations, () => now);
  return { execute, store, observations, service };
}
describe('persistent authorized evidence', () => {
  it('keeps observation identity stable across diagnostic requests', async () => {
    const f = fixture();
    const first = (await f.service.getBundle(actor, ref)).facts[0];
    const second = (await f.service.getBundle({ ...actor, requestId: 'another-request' }, ref)).facts[0];
    expect(second.id).toBe(first.id);
    expect(second.correlationId).toMatch(/^observation:/);
  });
  it('includes UTC evidence inside an offset historical window', async () => {
    const f = fixture();
    const saved = (await f.service.getBundle(actor, ref)).facts[0];
    f.execute.mockResolvedValueOnce([[{ evidence_json: JSON.stringify(saved) }], []]);
    const result = await f.service.getBundle(actor, ref, { from: '2026-09-08T07:59:00+08:00', to: '2026-09-08T08:01:00+08:00' });
    expect(result.facts).toEqual([saved]);
  });
  it('does not claim truncation when the live result exactly meets the limit', async () => {
    const f = fixture();
    const result = await f.service.getBundle(actor, ref, { limit: 1 });
    expect(result.facts).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(f.observations).toHaveBeenCalledWith(actor, ref, { limit: 2 });
  });
  it('uses a bounded stored sentinel to distinguish exact and omitted results', async () => {
    const f = fixture();
    const saved = (await f.service.getBundle(actor, ref)).facts[0];
    const { id, ...content } = saved;
    const extraContent = { ...content, payload: { metricId: 'memory_usage', value: 2 } };
    const extra = { ...extraContent, id: evidenceId(extraContent) };
    const options = { from: '2026-09-08T00:00:00.000Z', to: now.toISOString(), limit: 1 };
    f.execute.mockResolvedValueOnce([[{ evidence_json: saved }], []]);
    expect((await f.service.getBundle(actor, ref, options)).truncated).toBe(false);
    f.execute.mockResolvedValueOnce([[{ evidence_json: saved }, { evidence_json: extra }], []]);
    const result = await f.service.getBundle(actor, ref, options);
    expect(result.facts).toHaveLength(1); expect(result.truncated).toBe(true);
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT 2'), expect.any(Array));
    await f.service.getBundle(actor, ref, { ...options, limit: 100 });
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT 101'), expect.any(Array));
  });
  it('reports proven live observation omission using the extra observation', async () => {
    const f = fixture();
    const observation = (await f.observations())[0];
    f.observations.mockResolvedValueOnce([observation, { ...observation, metricId: 'memory_usage' }]);
    const result = await f.service.getBundle(actor, ref, { limit: 1 });
    expect(result.facts).toHaveLength(1); expect(result.truncated).toBe(true);
    expect(f.observations).toHaveBeenLastCalledWith(actor, ref, { limit: 2 });
  });
  it('persists real observations with ownership and marks stale evidence as a gap', async () => {
    const f = fixture();
    const bundle = await f.service.getBundle(actor, ref);
    expect(bundle.facts).toHaveLength(1);
    expect(bundle.gaps).toContain('EVIDENCE_STALE');
    expect(f.execute.mock.calls.flat().join(' ')).toContain('INSERT');
    expect(f.execute).toHaveBeenCalledWith(expect.stringContaining('owner_user_id'), expect.arrayContaining([7, 'instance', 1]));
  });
  it('denies forbidden resources before collection or stored ID access', async () => {
    const f = fixture();
    await expect(f.service.getBundle(actor, { ...ref, id: 2 })).rejects.toThrow('RESOURCE_FORBIDDEN');
    await expect(f.service.getItem(actor, { ...ref, id: 2 }, 'a'.repeat(64))).rejects.toThrow('RESOURCE_FORBIDDEN');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.observations).not.toHaveBeenCalled();
  });
  it('requires actor and resource predicates in ID reads and fails closed without storage', async () => {
    const f = fixture();
    expect(await f.service.getItem(actor, ref, 'a'.repeat(64))).toBeNull();
    expect(f.execute).toHaveBeenCalledWith(expect.stringMatching(/owner_user_id = \?.*resource_type = \?.*resource_id = \?/s), [actor.userId, ref.type, ref.id, 'a'.repeat(64)]);
    await expect(new EvidenceStore(() => null).query(actor, ref, { from: now.toISOString(), to: now.toISOString(), limit: 1 })).rejects.toThrow('EVIDENCE_STORAGE_UNAVAILABLE');
  });
  it('rejects oversized time windows and invalid limits before queries', async () => {
    const f = fixture();
    await expect(f.service.getBundle(actor, ref, { from: '2020-01-01T00:00:00.000Z', to: now.toISOString() })).rejects.toThrow('EVIDENCE_QUERY_INVALID');
    await expect(f.service.getBundle(actor, ref, { limit: NaN })).rejects.toThrow('EVIDENCE_QUERY_INVALID');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('loads persisted evidence on a new service and rejects mismatched resource payloads', async () => {
    const f = fixture();
    const bundle = await f.service.getBundle(actor, ref);
    const saved = bundle.facts[0];
    f.execute.mockResolvedValueOnce([[{ evidence_json: JSON.stringify(saved) }], []]);
    const restarted = new EvidenceService(f.store, f.observations, () => now);
    expect(await restarted.getItem(actor, ref, saved.id)).toEqual(saved);
    const { id, ...content } = saved;
    const other = { ...content, subject: { resource: { ...ref, id: 2 } } };
    f.execute.mockResolvedValueOnce([[{ evidence_json: JSON.stringify({ ...other, id: evidenceId(other) }) }], []]);
    expect(await restarted.getItem(actor, ref, saved.id)).toBeNull();
  });
  it('does not collect for historical queries and returns an explicit empty gap', async () => {
    const f = fixture();
    const result = await f.service.getBundle(actor, ref, { from: '2026-09-07T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' });
    expect(f.observations).not.toHaveBeenCalled();
    expect(result.gaps).toContain('NO_EVIDENCE_IN_WINDOW');
  });
});
