import { describe, expect, it } from 'vitest';
import { correlate, observationWindow, WINDOW_MS, type AttentionEvent, type AttentionEdge } from './correlator.js';
const from = '2026-10-17T00:00:00.000Z';
const resource = (id: number) => ({ type: 'instance' as const, id });
const event = (id: string, ref = 1, seconds = 0, signature: string | null = null): AttentionEvent => ({ id, resource: resource(ref), occurredAt: new Date(Date.parse(from) + seconds * 1000).toISOString(), severity: 'error', investigationId: 'original-investigation', signature });
const edge = (id: string, source: number, target: number): AttentionEdge => ({ id, version: 2, hash: 'a'.repeat(64), source: resource(source), target: resource(target), validUntil: '2026-10-18T00:00:00.000Z' });
describe('B08 deterministic correlation, original observation clock', () => {
  it('pins quarter-hour by occurrence rather than receipt or replay time', () => {
    expect(observationWindow('2026-10-17T00:14:59.999Z')).toEqual({ from, until: '2026-10-17T00:15:00.000Z' });
    expect(observationWindow('2026-10-17T00:15:00.000Z').from).toBe('2026-10-17T00:15:00.000Z');
    expect(() => correlate([event('a', 1, 900)], [], from)).toThrow();
    expect(() => correlate([event('a', 1, -1)], [], from)).toThrow();
  });
  it('replays identical output after shuffling sources and does not claim causation', () => {
    const events = [event('c', 2, 10), event('a', 1), event('b', 1, 5)], edges = [edge('2', 3, 2), edge('1', 1, 3)];
    const result = correlate(events, edges, from);
    expect(correlate([...events].reverse(), [...edges].reverse(), from)).toEqual(result);
    expect(result.groups).toHaveLength(1); expect(result.groups[0]).toMatchObject({ eventIds: ['a', 'b', 'c'], investigationIds: ['original-investigation'], correlationIsCausation: false });
    expect(result.groups[0].reasons.some(r => r.relationIds.join(',') === '1,2')).toBe(true);
  });
  it('does not traverse three hops and caps inspected edges at 100', () => {
    expect(correlate([event('a', 1), event('b', 4)], [edge('1', 1, 2), edge('2', 2, 3), edge('3', 3, 4)], from).groups).toHaveLength(2);
    const edges = Array.from({ length: 100 }, (_, i) => edge(String(i).padStart(3, '0'), i + 100, i + 101));
    const value = correlate([event('a', 1), event('b', 4)], [...edges, edge('zzz', 1, 4)], from);
    expect(value.partial).toBe(true); expect(value.groups).toHaveLength(2);
  });
  it('links only registry-known signatures across unrelated resources', () => {
    expect(correlate([event('a', 1), event('b', 2)], [], from).groups).toHaveLength(2);
    const result = correlate([event('a', 1, 0, 'known-timeout/1'), event('b', 2, 60, 'known-timeout/1')], [], from);
    expect(result.groups).toHaveLength(1); expect(result.groups[0].reasons[0].kind).toBe('known_signature');
  });
  it('retains group identity when a late event predates its original anchor', () => {
    const before = correlate([event('b', 1, 20)], [], from);
    const after = correlate([event('a', 1), event('b', 1, 20)], [], from, {}, before.groups);
    expect(after.groups[0].id).toBe(before.groups[0].id); expect(before.groups[0].eventIds).toEqual(['b']);
  });
  it('scores observed recurrence span and preserves partial baseline uncertainty', () => {
    const value = correlate([event('a', 1), event('b', 1, WINDOW_MS / 2000)], [], from, { 'instance:1': 1 });
    expect(value.groups[0].score.components).toMatchObject({ impact: null, persistence: 7.5, baseline: 15 });
    const missing = correlate([event('a', 1, 0, 'known'), event('b', 2, 60, 'known')], [], from, { 'instance:1': 1 });
    expect(missing.groups[0].score.components.baseline).toBeNull();
  });
  it('bounds explanation size for a thousand same-resource events', () => {
    const value = correlate(Array.from({ length: 1000 }, (_, i) => event(String(i), 1, i / 2)), [], from);
    expect(value.groups).toHaveLength(1); expect(value.groups[0].reasons).toHaveLength(999);
  });
});
