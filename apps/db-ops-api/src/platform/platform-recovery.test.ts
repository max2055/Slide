import { describe, expect, it } from 'vitest';
import { StructuredLogEvidenceAdapter } from './structured-log-evidence-adapter.js';

describe('MAX243 recovery uses original failure and actual post-failure evidence', () => {
  function fixture() {
    let now = Date.parse('2026-11-01T00:00:00.000Z');
    const logs = new StructuredLogEvidenceAdapter(() => now);
    const event = { occurredAt: new Date(now).toISOString(), callsite: 'api:GET:/failure', releaseId: 'r1', commitSha: 'a'.repeat(40), correlationId: 'original' };
    logs.record({ component: 'api', eventType: 'request.completed', status: 'failed', ...event, requestScope: 'c'.repeat(64) });
    const record = (status: 'ok'|'failed'|'unknown', patch = {}) => { now += 1000; logs.record({ component: 'api', eventType: 'request.completed', status, ...event, correlationId: `later-${now}`, requestScope: 'c'.repeat(64), ...patch }); };
    return { logs, event, record, later: (ms: number) => { now += ms; } };
  }
  it('analysis completion, general success and self-check cannot substitute for exact later observation', () => {
    const f = fixture();
    f.record('ok', { callsite: 'api:GET:/api/health' });
    expect(f.logs.verifyFailure(f.event, true)).toMatchObject({ conclusion: 'insufficient_evidence', gaps: ['LOG_EVIDENCE_MISSING'] });
  });
  it('separates still failing and later valid recovery without claiming whole-platform health', () => {
    const f = fixture(); f.record('failed');
    expect(f.logs.verifyFailure(f.event, true).conclusion).toBe('not_improved');
    f.record('ok');
    expect(f.logs.verifyFailure(f.event, true)).toMatchObject({ conclusion: 'recovered', gaps: [], observation: { callsite: f.event.callsite } });
    f.record('failed'); expect(f.logs.verifyFailure(f.event, true).conclusion).toBe('not_improved');
  });
  it.each([
    { patch: { releaseId: 'r2' }, gap: 'SOURCE_COMMIT_MISMATCH' },
    { patch: { commitSha: 'b'.repeat(40) }, gap: 'SOURCE_COMMIT_MISMATCH' },
    { patch: { status: 'unknown' }, gap: 'LOG_STATUS_UNKNOWN' },
  ])('rejects deployment changes or unknown outcomes $gap', ({patch,gap}) => {
    const f = fixture(); f.record('ok', patch);
    expect(f.logs.verifyFailure(f.event, true)).toMatchObject({ conclusion: 'insufficient_evidence', gaps: expect.arrayContaining([gap]) });
  });
  it('disabled collection, missing deployment, stale evidence and restart stay unknown', () => {
    const f = fixture(); f.record('ok');
    expect(f.logs.verifyFailure(f.event, false).gaps).toContain('SYSTEM_COLLECTION_DISABLED');
    expect(f.logs.verifyFailure({ ...f.event, commitSha: undefined }, true).conclusion).toBe('insufficient_evidence');
    f.later(301_000); expect(f.logs.verifyFailure(f.event, true).conclusion).toBe('insufficient_evidence');
    const restarted = new StructuredLogEvidenceAdapter(() => Date.parse(f.event.occurredAt) + 5000);
    expect(restarted.verifyFailure(f.event, true).gaps).toContain('LOG_WINDOW_PRECEDES_PROCESS');
  });
  it('does not accept success preceding the failure or invalid label content', () => {
    const f = fixture(); f.record('ok', { callsite: 'api:GET:/failure?secret=never-store' });
    expect(JSON.stringify(f.logs.query({}))).not.toContain('never-store');
    expect(f.logs.verifyFailure(f.event, true).conclusion).toBe('insufficient_evidence');
    f.record('ok');
    expect(f.logs.verifyFailure({ ...f.event, occurredAt: '2026-11-01T00:00:03.000Z' }, true).conclusion).toBe('insufficient_evidence');
  });
  it('R1: legacy/missing, malformed or unrelated request scope never proves recovery', () => {
    const f = fixture();
    f.record('ok', { requestScope: 'd'.repeat(64) });
    expect(f.logs.verifyFailure(f.event, true).conclusion).toBe('insufficient_evidence');
    f.record('ok', { requestScope: 'not-a-scope' });
    expect(f.logs.verifyFailure(f.event, true).conclusion).toBe('insufficient_evidence');
    f.record('ok');
    expect(f.logs.verifyFailure({ ...f.event, correlationId: undefined }, true).gaps).toContain('LOG_REQUEST_SCOPE_UNAVAILABLE');
    expect(f.logs.verifyFailure({ ...f.event, correlationId: 'unavailable' }, true).gaps).toContain('LOG_REQUEST_SCOPE_UNAVAILABLE');
  });
});
