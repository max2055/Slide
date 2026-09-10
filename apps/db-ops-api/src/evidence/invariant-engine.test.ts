import { describe, expect, it } from 'vitest';
import { evaluateInvariants } from './invariant-engine.js';
import { evaluateExpectation } from './expectation-engine.js';
import type { EvidenceItem } from './evidence-contract.js';
const now = Date.parse('2026-09-08T10:00:00Z');
function item(value: number | null, observedAt = new Date(now - 1000).toISOString()): EvidenceItem {
  return { id: 'a'.repeat(64), schemaVersion: 1, kind: 'observation', status: 'fact', subject: { resource: { type: 'server', id: 1 } }, quality: 'good', observedAt, validUntil: new Date(now + 60_000).toISOString(), source: 'collector', correlationId: 'r', provenance: 'collector', payload: { metricId: 'cpu', value } };
}
describe('evidence evaluations', () => {
  it('keeps missing and expired evidence unknown instead of pass', () => {
    const rules = [{ id: 'cpu-limit', version: 1, metricId: 'cpu', max: 90 }];
    expect(evaluateInvariants([], rules, now)[0].status).toBe('unknown');
    expect(evaluateInvariants([{ ...item(1), validUntil: new Date(now - 1).toISOString() }], rules, now)[0].status).toBe('unknown');
    expect(evaluateInvariants([item(null)], rules, now)[0].status).toBe('unknown');
  });
  it('distinguishes deterministic failure from missing coverage and retains evidence refs', () => {
    const result = evaluateInvariants([item(99)], [{ id: 'cpu-limit', version: 1, metricId: 'cpu', max: 90 }], now)[0];
    expect(result.status).toBe('fail'); expect(result.evidenceRefs).toEqual(['a'.repeat(64)]);
  });
  it('does not mix dimensions or pretend small samples are a normal baseline', () => {
    const current = item(99); const history = Array.from({ length: 20 }, (_, i) => ({ ...item(10 + i % 2, new Date(now - 60000 - i * 1000).toISOString()), id: String(i).padStart(64, '0') }));
    expect(evaluateExpectation(current, history, now).status).toBe('deviation');
    expect(evaluateExpectation(current, history.slice(0, 2), now).status).toBe('unknown');
    expect(evaluateExpectation({ ...current, dimensions: { device: 'sda' } }, history, now).status).toBe('unknown');
  });
});
