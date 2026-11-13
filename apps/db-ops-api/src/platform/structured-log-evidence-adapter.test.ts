import { describe, expect, it } from 'vitest';
import { StructuredLogEvidenceAdapter } from './structured-log-evidence-adapter.js';

describe('platform log evidence', () => {
  it('separates job types, retains worst observed wait, and counts only duration samples', () => {
    const adapter = new StructuredLogEvidenceAdapter();
    for (const durationMs of [5, 50]) adapter.record({ component: 'queue', eventType: 'job.wait', jobType: 'capacity.collect', status: 'ok', durationMs });
    adapter.record({ component: 'queue', eventType: 'job.wait', jobType: 'notification.deliver', status: 'ok', durationMs: 10000 });
    expect(adapter.query({}).groups).toHaveLength(2);
    expect(adapter.query({}).groups[0]).toMatchObject({ jobType: 'capacity.collect', count: 2, durationMs: 55, durationSamples: 2, maxDurationMs: 50 });
  });
  it('reports omitted aggregation groups and does not conflate colon-delimited labels', () => {
    const adapter = new StructuredLogEvidenceAdapter();
    adapter.record({ component: 'a:b', eventType: 'c', status: 'ok' });
    adapter.record({ component: 'a', eventType: 'b:c', status: 'failed' });
    expect(adapter.query({}).groups).toHaveLength(2);
    for (let i = 0; i < 101; i++) adapter.record({ component: 'api', eventType: `event${i}`, status: 'ok' });
    expect(adapter.query({}).gaps).toContain('LOG_GROUPS_TRUNCATED');
  });
  it('aggregates without retaining message bodies or credentials', () => {
    const adapter = new StructuredLogEvidenceAdapter(() => Date.parse('2026-09-08T10:00:00Z'));
    adapter.record({ component: 'api', eventType: 'request', status: 'failed', durationMs: 12, errorCode: 'API_FAILURE', message: 'password=secret', sql: 'select sensitive', token: 'hidden' } as any);
    const result = adapter.query({});
    expect(result.groups[0]).toMatchObject({ component: 'api', count: 1, failures: 1 });
    expect(JSON.stringify(result)).not.toMatch(/password|secret|sensitive|hidden/);
  });
  it('does not represent missing, stale or dropped logs as healthy', () => {
    let now = Date.parse('2026-09-08T10:00:00Z'); const adapter = new StructuredLogEvidenceAdapter(() => now, 2);
    expect(adapter.query({}).quality).toBe('unknown');
    for (let i = 0; i < 3; i++) adapter.record({ component: 'api', eventType: 'request', status: 'ok' });
    expect(adapter.query({}).gaps).toContain('LOG_BUFFER_TRUNCATED');
    now += 600_000; expect(adapter.query({}).quality).toBe('unknown');
  });
  it('validates bounded time windows and component filters', () => {
    const adapter = new StructuredLogEvidenceAdapter();
    expect(() => adapter.query({ from: 'invalid' })).toThrow('PLATFORM_LOG_QUERY_INVALID');
    expect(() => adapter.query({ from: '2020-01-01T00:00:00Z' })).toThrow('PLATFORM_LOG_WINDOW_INVALID');
    expect(() => adapter.record({ component: 'api?token=abc', eventType: 'request', status: 'ok' })).toThrow('PLATFORM_LOG_INVALID');
  });
});

// MAX-440 / #544: truncation describes lost event time, not eviction time.
describe('evicted event windows', () => {
  const origin = Date.parse('2026-09-08T10:00:00Z');
  const iso = (minutes: number) => new Date(origin + minutes * 60000).toISOString();
  it('preserves a complete recent window and inclusive lost boundaries', () => {
    let now = origin;
    const adapter = new StructuredLogEvidenceAdapter(() => now, 2);
    for (let i = 0; i < 3; i++) { now = origin + i * 60000; adapter.record({ component: 'api', eventType: 'request', status: 'ok' }); }
    expect(adapter.query({ from: iso(1), to: iso(2) })).toMatchObject({ quality: 'good', gaps: [] });
    expect(adapter.query({ from: iso(0), to: iso(0) }).gaps).toContain('LOG_BUFFER_TRUNCATED');
    expect(adapter.query({ from: iso(0.001), to: iso(2) }).gaps).not.toContain('LOG_BUFFER_TRUNCATED');
  });
  it('compares both endpoints across consecutive evictions and expires loss metadata', () => {
    let now = origin;
    const adapter = new StructuredLogEvidenceAdapter(() => now, 2);
    for (let i = 1; i < 5; i++) { now = origin + i * 60000; adapter.record({ component: 'api', eventType: 'request', status: 'ok' }); }
    expect(adapter.query({ from: iso(0), to: iso(0.5) }).gaps).not.toContain('LOG_BUFFER_TRUNCATED');
    expect(adapter.query({ from: iso(2), to: iso(3) }).gaps).toContain('LOG_BUFFER_TRUNCATED');
    expect(adapter.query({ from: iso(3), to: iso(4) }).quality).toBe('good');
    now = origin + 65 * 60000;
    adapter.record({ component: 'api', eventType: 'request', status: 'ok' });
    expect(adapter.query({ from: iso(5), to: iso(65) }).gaps).not.toContain('LOG_BUFFER_TRUNCATED');
    expect(adapter.query({ from: iso(65), to: iso(65) }).quality).toBe('good');
  });
  it('shares the event-time boundary with failure verification', () => {
    let now = origin;
    const adapter = new StructuredLogEvidenceAdapter(() => now, 2);
    adapter.record({ component: 'queue', eventType: 'job', status: 'ok' });
    now += 60000;
    const identity = { callsite: '/api/test', releaseId: 'test', commitSha: 'a'.repeat(40), requestScope: 'b'.repeat(64) };
    adapter.record({ ...identity, component: 'api', eventType: 'request.completed', status: 'failed', correlationId: 'original' });
    now += 60000;
    adapter.record({ ...identity, component: 'api', eventType: 'request.completed', status: 'ok' });
    expect(adapter.verifyFailure({ ...identity, occurredAt: iso(1), correlationId: 'original' }, true)).toMatchObject({ conclusion: 'recovered', gaps: [] });
    expect(adapter.verifyFailure({ ...identity, occurredAt: iso(0), correlationId: 'original' }, true).gaps).toContain('LOG_BUFFER_TRUNCATED');
  });
});
