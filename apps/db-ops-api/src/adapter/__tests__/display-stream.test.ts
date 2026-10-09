import { afterEach, describe, it, expect, vi } from 'vitest';
import { DisplayStreamAuthority, loadDisplayStreamLimits } from '../display-stream.js';
import { createMessageProjection, reduceMessageProjection, type ProjectionFrame, type ProjectionOperation } from '@slide/agent-core/message-projection';
import { reduceDisplayStream, type DisplayStreamEvent, type DisplayStreamState } from '@slide/agent-core/display-stream';

afterEach(() => vi.useRealTimers());
function fixture(limits = {}) {
  const hub = new DisplayStreamAuthority(limits);
  let state = createMessageProjection('run');
  hub.start('session', 'run', 'turn', () => state);
  const events: DisplayStreamEvent[] = [];
  hub.watch({}, 'session', 'sub', event => { events.push(structuredClone(event)); return true; });
  const publish = (...operations: ProjectionOperation[]) => {
    const frame: ProjectionFrame = { version: 1, runId: 'run', attempt: 1, sequence: state.sequence + 1, operations };
    state = reduceMessageProjection(state, frame); hub.publish('session', frame);
    return state;
  };
  return { hub, events, publish, state: () => state };
}
const start: ProjectionOperation = { type: 'part.start', messageId: 'message', part: { id: 'part', type: 'text', text: 'first', source: 'fact', status: 'partial' } };
describe('synchronous bounded display authority', () => {
  it('cold history hydration does not imply truncated execution output', () => {
    const hub = new DisplayStreamAuthority();
    try {
      const events: DisplayStreamEvent[] = [];
      hub.watch({}, 'history', 'sub', e => { events.push(e); return true; });
      expect(events[0].recovery).toMatchObject({ cold: true, truncated: false });
    } finally { hub.dispose(); }
  });
  it('cold watch with a real run cursor identifies the missing replay boundary', () => {
    const hub = new DisplayStreamAuthority();
    try {
      const events: DisplayStreamEvent[] = [];
      hub.watch({}, 'session', 'sub', e => { events.push(e); return true; },
        { streamEpoch: 'lost', runId: 'run', turnId: 'turn', toSeq: 3 });
      expect(events[0].recovery).toMatchObject({ cold: true, truncated: true, detailRef: { runId: 'run' } });
    } finally { hub.dispose(); }
  });

  it('a full projection leaves no unaccounted pending operation under a small configured cap', () => {
    vi.useFakeTimers(); const f = fixture({ maxRunOps: 2, maxGlobalOps: 2 });
    try {
      f.publish(start, { ...start, part: { ...start.part, id: 'second' } } as ProjectionOperation);
      f.publish({ type: 'part.append', partId: 'part', text: 'suffix' });
      expect(f.hub.stats().ops).toBeLessThanOrEqual(2);
      expect(f.events.at(-1)?.projection?.operations[0]).toMatchObject({ type: 'part.append', text: 'suffix' });
    } finally { f.hub.dispose(); }
  });
  it('body bytes grow exactly linearly for 500/1000/2000 fragments under equal sampling', () => {
    vi.useFakeTimers();
    const measured = [500, 1000, 2000].map(n => {
      const f = fixture();
      try {
        f.publish({ ...start, part: { ...start.part, text: 'a'.repeat(100) } } as ProjectionOperation);
        for (let i = 1; i < n; i++) { f.publish({ type: 'part.append', partId: 'part', text: 'a'.repeat(100) }); vi.advanceTimersByTime(1); }
        f.publish({ type: 'part.end', partId: 'part' });
        return f.events.reduce((sum, e) => sum + (e.projection?.operations.reduce((total, o) => total + (o.type === 'part.append' ? Buffer.byteLength(o.text)
          : o.type === 'part.start' && 'text' in o.part ? Buffer.byteLength(o.part.text ?? '') : 0), 0) ?? 0), 0);
      } finally { f.hub.dispose(); }
    });
    expect(measured).toEqual([50_000, 100_000, 200_000]);
  });
  it('progress uses 200ms and a terminal flushes it without waiting for the window', () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      f.publish({ type: 'tool.state', messageId: 'message', partId: 'tool', event: { toolCallId: 'call', name: 'query', phase: 'running', occurredAt: 1 } });
      const count = f.events.length;
      f.publish({ type: 'tool.progress', messageId: 'message', partId: 'tool', event: { toolCallId: 'call', name: 'query', phase: 'running', occurredAt: 2, progress: { completed: 1 } } });
      vi.advanceTimersByTime(199); expect(f.events).toHaveLength(count);
      vi.advanceTimersByTime(1); expect(f.events.at(-1)?.projection?.operations[0].type).toBe('tool.progress');
      f.publish({ type: 'tool.progress', messageId: 'message', partId: 'tool', event: { toolCallId: 'call', name: 'query', phase: 'running', occurredAt: 3, progress: { completed: 2 } } });
      f.publish({ type: 'run.terminal', outcome: 'cancelled' });
      expect(f.events.slice(-2).map(e => e.projection?.operations[0].type)).toEqual(['tool.progress', 'run.terminal']);
    } finally { f.hub.dispose(); }
  });
  it('first feedback is immediate; same-part appends batch; reset/tool/terminal are flush barriers', () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.publish(start);
      expect(f.events.at(-1)?.projection?.operations).toEqual([start]);
      f.publish({ type: 'part.append', partId: 'part', text: 'a' });
      f.publish({ type: 'part.append', partId: 'part', text: 'b' });
      expect(f.events).toHaveLength(2);
      f.publish({ type: 'stream.reset', anchor: { id: 'anchor', parts: [] } });
      expect(f.events.slice(-2).map(e => e.projection?.operations[0].type)).toEqual(['part.append', 'stream.reset']);
      expect(f.events.at(-2)?.projection?.operations[0]).toMatchObject({ text: 'ab' });
      f.publish(start);
      f.publish({ type: 'part.append', partId: 'part', text: 'tail' });
      f.publish({ type: 'run.terminal', outcome: 'failed', error: 'fixture' });
      expect(f.events.at(-1)?.projection?.operations.at(-1)?.type).toBe('run.terminal');
      expect(f.hub.stats().pendingBytes).toBe(0);
    } finally { f.hub.dispose(); }
  });
  it('captures W and registers suffix together, including reentrant publish while delivering snapshot', () => {
    const f = fixture();
    try {
      f.publish(start);
      const captured: DisplayStreamEvent[] = [];
      f.hub.watch({}, 'session', 'watcher', event => {
        captured.push(structuredClone(event));
        if (event.type === 'stream.snapshot') f.publish({ type: 'part.append', partId: 'part', text: 'race' }, { type: 'part.end', partId: 'part' });
        return true;
      });
      expect(captured.map(e => e.type)).toEqual(['stream.snapshot', 'stream.delta']);
      let projection: DisplayStreamState = { subscriptionId: 'watcher', recovering: true };
      for (const event of captured) projection = reduceDisplayStream(projection, event).state;
      expect(projection.projection).toEqual(f.state());
      expect(captured[1].stream.fromSeq).toBe(captured[0].stream.toSeq + 1);
    } finally { f.hub.dispose(); }
  });
  it('same epoch resumes retained suffix; overflow, terminal TTL and cache eviction fall back to bounded snapshots', () => {
    vi.useFakeTimers();
    const f = fixture({ maxRunOps: 3, maxGlobalOps: 300, maxSnapshotBytes: 8192, maxRunBytes: 16384, maxGlobalBytes: 16384, maxSnapshotParts: 2, textBatchBytes: 256, terminalTtlMs: 100 });
    try {
      f.publish(start);
      const cursor = f.events.at(-1)!.stream;
      f.publish({ type: 'run.status', phase: 'tools' });
      const resumed: DisplayStreamEvent[] = [];
      f.hub.watch({}, 'session', 'resume', e => { resumed.push(e); return true; }, cursor);
      expect(resumed.map(e => e.type)).toEqual(['stream.delta']);
      for (let i = 0; i < 8; i++) f.publish({ type: 'run.status', phase: i % 2 ? 'generating' : 'tools' });
      const expired: DisplayStreamEvent[] = [];
      f.hub.watch({}, 'session', 'expired', e => { expired.push(e); return true; }, cursor);
      expect(expired[0].type).toBe('stream.snapshot');
      f.publish({ type: 'part.append', partId: 'part', text: '长'.repeat(20_000) });
      expect(f.hub.stats().bytes).toBeLessThanOrEqual(16384);
      expect(f.events.at(-1)?.recovery?.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(f.events.at(-1)))).toBeLessThanOrEqual(8192);
      f.publish({ type: 'run.terminal', outcome: 'failed' });
      f.hub.end('session', 'run');
      vi.advanceTimersByTime(100);
      expect(f.hub.stats().runs).toBe(0);
      const cold: DisplayStreamEvent[] = [];
      f.hub.watch({}, 'session', 'cold', e => { cold.push(e); return true; });
      expect(cold[0].recovery?.cold).toBe(true);
    } finally { f.hub.dispose(); }
  });
  it('global cache and per-peer subscription caps hold across many runs', () => {
    const hub = new DisplayStreamAuthority({ maxRuns: 2, maxSubscriptionsPerPeer: 2 });
    try {
      const peer = {};
      for (let i = 0; i < 20; i++) {
        const run = createMessageProjection(`run-${i}`);
        hub.start(`session-${i}`, run.runId, 'turn', () => run);
        hub.publish(`session-${i}`, { version: 1, runId: run.runId, attempt: 0, sequence: 1, operations: [{ type: 'run.status', phase: 'generating' }] });
      }
      expect(hub.stats().runs).toBeLessThanOrEqual(2);
      expect(hub.stats().sources).toBeLessThanOrEqual(2);
      expect(hub.watch(peer, 'a', 'a', () => true)).toBe(true);
      expect(hub.watch(peer, 'b', 'b', () => true)).toBe(true);
      expect(hub.watch(peer, 'c', 'c', () => true)).toBe(false);
      hub.unwatch(peer); expect(hub.stats().subscriptions).toBe(0);
      expect(() => loadDisplayStreamLimits({ maxSnapshotBytes: 1 })).toThrow();
    } finally { hub.dispose(); }
  });
});
