import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { validateFeedback, coversRecoveryWindow } from './feedback-contracts.js';

const base = { resultId: randomUUID(), resultVersion: 1, expectedVersion: 2, note: '人工检查' };
const verification = { method: '核对有界指标', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:00.000Z', evidenceIds: [randomUUID()] };
describe('T11 human feedback contracts', () => {
  it.each(['helpful', 'unhelpful', 'incorrect'])('accepts %s feedback without knowledge publication authority', rating => {
    expect(validateFeedback({ ...base, kind: 'rating', rating }).kind).toBe('rating');
  });
  it.each([
    { kind: 'close', lifecycle: 'closed', problemStatus: 'resolved' },
    { kind: 'recovery', verification: { ...verification, evidenceIds: [] } },
    { kind: 'root_cause', verification: { ...verification, verifiedBy: 1 } },
    { kind: 'root_cause', verification: { ...verification, verifiedAt: '2026-01-01T00:02:00.000Z' } },
    { kind: 'root_cause', verification: { ...verification, from: '2026-02-30T00:00:00.000Z' } },
    { kind: 'recovery', verification: { ...verification, to: verification.from } },
    { kind: 'close', lifecycle: 'closed', problemStatus: 'not_applicable', verification },
    { kind: 'handling', performedAt: '2999-01-01T00:00:00.000Z', evidenceIds: [] },
    { kind: 'rating', rating: 'incorrect', knowledgeTrusted: true },
  ])('rejects unsafe human command %#', value => {
    expect(() => validateFeedback({ ...base, ...value })).toThrow('INVESTIGATION_INPUT_INVALID');
  });
  it('root cause, recovery and closure remain separate commands', () => {
    expect(validateFeedback({ ...base, kind: 'root_cause', verification })).not.toHaveProperty('problemStatus');
    expect(validateFeedback({ ...base, kind: 'recovery', verification })).not.toHaveProperty('lifecycle');
    expect(validateFeedback({ ...base, kind: 'close', lifecycle: 'closed', problemStatus: 'not_applicable' }).kind).toBe('close');
  });
  it('missing/partial observation cannot cover a recovery window', () => {
    expect(coversRecoveryWindow(verification, [{ observedFrom: null, observedTo: null, collectedAt: verification.to }])).toBe(false);
    expect(coversRecoveryWindow(verification, [{ observedFrom: verification.to, observedTo: verification.to, collectedAt: verification.to }])).toBe(false);
    expect(coversRecoveryWindow(verification, [{ observedFrom: verification.from, observedTo: verification.to, collectedAt: verification.to }])).toBe(true);
  });
});
