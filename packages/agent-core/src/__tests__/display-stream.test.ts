import { describe, it, expect } from 'vitest';
import { createMessageProjection } from '../message-projection.js';
import { reduceDisplayStream, type DisplayStreamEvent, type DisplayStreamState } from '../display-stream.js';

const snapshot = (epoch = 'epoch', subscriptionId = 'sub', toSeq = 0): DisplayStreamEvent => ({ type: 'stream.snapshot', sessionKey: 'session',
  stream: { version: 1, streamEpoch: epoch, subscriptionId, runId: 'run', turnId: 'turn', fromSeq: toSeq, toSeq }, snapshot: createMessageProjection('run') });
const delta = (fromSeq: number, toSeq = fromSeq): DisplayStreamEvent => ({ type: 'stream.delta', sessionKey: 'session',
  stream: { ...snapshot().stream, fromSeq, toSeq }, projection: { version: 1, runId: 'run', attempt: 1, sequence: toSeq,
    operations: [{ type: 'part.start', messageId: 'message', part: { id: 'text', type: 'text', text: 'abc', source: 'fact', status: 'partial' } }] } });
describe('independent display cursor', () => {
  it('applies contiguous intervals, ignores duplicates and stops at gaps/overlaps', () => {
    const initial: DisplayStreamState = { subscriptionId: 'sub', recovering: true };
    const baseline = reduceDisplayStream(initial, snapshot()).state;
    const accepted = reduceDisplayStream(baseline, delta(1, 3));
    expect(accepted.result).toBe('applied');
    expect(accepted.state.cursor?.toSeq).toBe(3);
    expect(reduceDisplayStream(accepted.state, delta(1, 3)).state).toBe(accepted.state);
    expect(reduceDisplayStream(accepted.state, delta(3, 4)).result).toBe('recover');
    const gap = reduceDisplayStream(accepted.state, delta(5));
    expect(gap.result).toBe('recover');
    expect(gap.state.projection).toBe(accepted.state.projection);
    expect(reduceDisplayStream(gap.state, delta(4)).result).toBe('recover');
  });
  it('rejects old subscriptions and epochs, replaces entire state and watermark atomically', () => {
    const initial: DisplayStreamState = { subscriptionId: 'sub', recovering: true };
    const before = reduceDisplayStream(reduceDisplayStream(initial, snapshot()).state, delta(1)).state;
    expect(reduceDisplayStream(before, snapshot('epoch', 'old')).result).toBe('ignored');
    const epoch = reduceDisplayStream(before, snapshot('new'));
    expect(epoch.result).toBe('recover');
    const restored = reduceDisplayStream({ ...epoch.state, subscriptionId: 'new-sub' }, snapshot('new', 'new-sub', 7));
    expect(restored.state.projection?.parts).toEqual([]);
    expect(restored.state.cursor).toMatchObject({ streamEpoch: 'new', toSeq: 7 });
    expect(reduceDisplayStream(restored.state, snapshot('epoch', 'sub')).result).toBe('ignored');
  });
  it('malformed operation does not advance cursor or change tools/phase', () => {
    const baseline = reduceDisplayStream({ subscriptionId: 'sub', recovering: true }, snapshot()).state;
    const event = delta(1); event.projection!.operations = [{ type: 'run.status', phase: 'invented' } as any];
    const invalid = reduceDisplayStream(baseline, event);
    expect(invalid.result).toBe('recover');
    expect(invalid.state.cursor).toEqual(baseline.cursor);
    expect(invalid.state.projection).toBe(baseline.projection);
  });
});
