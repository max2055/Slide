import { describe, expect, it } from 'vitest';
import { verifyRecoveryWindow } from './operation-verifier.js';
import type { EvidenceItem } from '../evidence/evidence-contract.js';
const ref = { type: 'server' as const, id: 1 };
const start = Date.parse('2026-09-08T10:00:00Z');
const plan = { resource: ref, metricId: 'cpu', max: 80, startedAt: new Date(start).toISOString(), windowSeconds: 60, maxSampleGapSeconds: 30 };
function sample(seconds: number, value = 10): EvidenceItem { return { schemaVersion: 1, id: String(seconds).padStart(64, '0'), kind: 'observation', status: 'fact', subject: { resource: ref }, quality: 'good', observedAt: new Date(start + seconds * 1000).toISOString(), validUntil: new Date(start + (seconds + 31) * 1000).toISOString(), source: 'collector', correlationId: 'r', provenance: 'collector', payload: { metricId: 'cpu', value } }; }
describe('independent recovery window', () => {
  it('does not hide a violating observation behind a repeated timestamp', () => {
    expect(verifyRecoveryWindow(plan, [sample(0), sample(30, 99), sample(30), sample(60)], start + 60_000).status).toBe('not-recovered');
    expect(verifyRecoveryWindow(plan, [sample(0), sample(0), sample(60)], start + 60_000).status).toBe('unknown');
  });
  it('never substitutes a different collector source for the bound source', () => {
    expect(verifyRecoveryWindow({ ...plan, source: 'expected' }, [sample(0), sample(30), sample(60)], start + 60_000).status).toBe('unknown');
  });
  it('rejects interior expiry gaps even when sample spacing is acceptable', () => {
    const first = { ...sample(0), validUntil: new Date(start + 5000).toISOString() };
    expect(verifyRecoveryWindow(plan, [first, sample(30), sample(60)], start + 60_000)).toMatchObject({ status: 'unknown', reason: 'RECOVERY_EVIDENCE_GAP' });
  });
  it('requires continuous fresh independent samples after the operation', () => {
    expect(verifyRecoveryWindow(plan, [sample(0)], start + 60_000).status).toBe('unknown');
    expect(verifyRecoveryWindow(plan, [sample(0), sample(30), sample(60)], start + 60_000).status).toBe('recovered');
    expect(verifyRecoveryWindow(plan, [sample(0), sample(30, 99), sample(60)], start + 60_000).status).toBe('not-recovered');
  });
  it('does not accept agent claims, old or wrong-resource samples', () => {
    expect(verifyRecoveryWindow(plan, [sample(-60), sample(-30), sample(0)], start + 60_000).status).toBe('unknown');
    expect(verifyRecoveryWindow(plan, [0, 30, 60].map(time => ({ ...sample(time), status: 'inference' })), start + 60_000).status).toBe('unknown');
    expect(verifyRecoveryWindow(plan, [0, 30, 60].map(time => ({ ...sample(time), subject: { resource: { ...ref, id: 2 } } })), start + 60_000).status).toBe('unknown');
  });
});
