import { describe, expect, it } from 'vitest';
import { StructuredLogEvidenceAdapter } from './structured-log-evidence-adapter.js';

describe('platform log evidence', () => {
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
