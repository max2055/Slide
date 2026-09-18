import { describe, expect, it } from 'vitest';
import { definitions, identify, sample } from '../contracts/metrics-v2/fixtures.js';
import { seriesIdentity, type MetricDefinition } from '../contracts/metrics-v2/index.js';
import { processCounter } from './counter.js';
import type { CounterStateAdapter, StateSnapshot } from './state.js';

/** Executable adapter CONTRACT model, deliberately not a production implementation. */
class MemoryModel implements CounterStateAdapter {
  private snapshots = new Map<string, StateSnapshot>();
  private receipts = new Map<string, NonNullable<Awaited<ReturnType<CounterStateAdapter['receipt']>>>>();
  fencingToken = '1';
  async load(series: string, namespace: string) {
    return structuredClone(this.snapshots.get(JSON.stringify([namespace, series])) ?? { revision: '0', state: null });
  }
  async receipt(inputId: string, namespace: string) {
    return structuredClone(this.receipts.get(JSON.stringify([namespace, inputId])) ?? null);
  }
  async commit(request: Parameters<CounterStateAdapter['commit']>[0]): ReturnType<CounterStateAdapter['commit']> {
    // No await between validation and update in this single-threaded model.
    if (request.fencingToken !== this.fencingToken) return 'fenced';
    const key = JSON.stringify([request.replayNamespace, request.series]);
    const receiptKey = JSON.stringify([request.replayNamespace, request.inputId]);
    const receipt = this.receipts.get(receiptKey);
    if (receipt && receipt.payloadDigest !== request.payloadDigest) return 'payload_conflict';
    if (receipt) return 'replayed';
    if ((this.snapshots.get(key)?.revision ?? '0') !== request.expectedRevision) return 'revision_conflict';
    this.snapshots.set(key, structuredClone({ revision: String(BigInt(request.expectedRevision) + 1n), state: request.state }));
    this.receipts.set(receiptKey, structuredClone({ payloadDigest: request.payloadDigest, outputs: request.outputs }));
    return 'committed';
  }
}
describe('state adapter contract model (not database or external-effect guarantees)', () => {
  it('fences old ownership, rejects stale revisions, keeps receipts and isolates replay', async () => {
    const store = new MemoryModel();
    const definition = definitions.find(d => d.id === 'host.network.bytes_total')!;
    const rate: MetricDefinition = { ...definition, id: 'host.network.rate', kind: 'gauge', temporality: 'instant', monotonic: false, value_type: 'float64', unit: 'By/s', aggregation: { ...definition.aggregation, time: ['last'] } };
    const a = sample(definition.id), series = seriesIdentity(a);
    const options = { context: { now: a.observed_at, stale_after_ms: 120000 }, max_gap_ms: 300000 };
    const initial = processCounter(a, definition, rate, 'rate', null, options);
    const request = { series, replayNamespace: 'online', expectedRevision: '0', fencingToken: '1', state: initial.state, inputId: a.id, payloadDigest: 'fixture-digest-a', outputs: [initial.output] };
    const workerA = await store.load(series, 'online'), workerB = await store.load(series, 'online');
    expect(workerA.revision).toBe(workerB.revision);
    store.fencingToken = '2';
    expect(await store.commit(request)).toBe('fenced');
    expect(await store.commit({ ...request, fencingToken: '2' })).toBe('committed');
    expect(await store.commit({ ...request, fencingToken: '2' })).toBe('replayed');
    expect(await store.commit({ ...request, fencingToken: '2', inputId: 'new-input' })).toBe('revision_conflict');
    const receipt = await store.receipt(a.id, 'online');
    expect(receipt!.outputs).toEqual([initial.output]);
    expect(receipt!.outputs[0].observation.quality.reason).toBe('counter_baseline');
    expect(await store.commit({ ...request, fencingToken: '2', payloadDigest: 'different' })).toBe('payload_conflict');
    const online = await store.load(series, 'online');
    const time = '2026-09-01T00:02:00Z';
    const b = identify({ ...a, observed_at: time, collected_at: time, stored_at: null, value: { encoding: 'uint64', value: '9007199254747053' }, source: { ...a.source, attempt_id: 'attempt-2' } });
    const transition = processCounter(b, definition, rate, 'rate', online.state, { ...options, context: { ...options.context, now: time } });
    expect(transition.output.observation.value).toEqual({ encoding: 'float64', value: 1 });
    expect(await store.commit({ ...request, replayNamespace: 'replay:fixture-v1', fencingToken: '2' })).toBe('committed');
    expect(await store.load(series, 'online')).toEqual(online);
    expect(await store.receipt(b.id, 'online')).toBeNull();
    const reloaded = JSON.parse(JSON.stringify(online));
    expect(processCounter(b, definition, rate, 'rate', reloaded.state, { ...options, context: { ...options.context, now: time } })).toEqual(transition);
  });
});
