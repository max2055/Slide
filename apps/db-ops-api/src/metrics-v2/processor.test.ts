import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { definitions, derived, identify, rawObservation, sample } from '../contracts/metrics-v2/fixtures.js';
import { seriesIdentity, validateDerivedObservation, validateLineage, validateObservation, type DerivedMetric, type MetricDefinition, type RawObservation } from '../contracts/metrics-v2/index.js';
import { processCounter } from './counter.js';
import { normalize, type Computation, type Observation } from './observation.js';
import { executeDerived } from './derived.js';
import { decode, encode, rational } from './arithmetic.js';
import type { CounterState } from './state.js';

const counter = definitions.find(d => d.id === 'host.network.bytes_total')!;
const rate: MetricDefinition = { ...counter, id: 'host.network.rate', kind: 'gauge', temporality: 'instant', monotonic: false, value_type: 'float64', unit: 'bit/s', aggregation: { ...counter.aggregation, time: ['last'] } };
const context = { now: '2026-09-01T01:00:00Z', stale_after_ms: 120000 };
function point(value: string, ms = 0) {
  const time = new Date(Date.parse('2026-09-01T00:01:00Z') + ms).toISOString();
  return identify({ ...sample(counter.id), observed_at: time, collected_at: time, stored_at: null,
    source: { ...sample(counter.id).source, attempt_id: `attempt-${ms}` }, value: { encoding: 'uint64' as const, value } });
}
const fixture = JSON.parse(readFileSync(new URL('../../../../docs/slide/metrics-v2/processor/fixtures.json', import.meta.url), 'utf8')) as { counter_cases: { name: string; before: string; after: string; elapsed_ms: number; expected: number | null; reason: string; bits?: '32'; wrap?: boolean; bound?: string }[] };
describe('counter fixtures', () => {
  it.each(fixture.counter_cases)('$name', c => {
    let first = point(c.before), second = point(c.after, c.elapsed_ms);
    if (c.bits) { first = identify({ ...first, counter: { ...first.counter!, bits: c.bits } }); second = identify({ ...second, counter: { ...second.counter!, bits: c.bits } }); }
    if (c.wrap) second = identify({ ...second, counter: { ...second.counter!, discontinuity: { epoch: 'wrap-1', observed_at: second.observed_at, reason: 'wrap' } } });
    const options = { context, max_gap_ms: 300000, max_increment_per_second: c.bound };
    const initial = processCounter(first, counter, rate, 'rate', null, options);
    expect(initial.output.observation.value).toBeNull();
    expect(initial.output.observation.quality.reason).toBe('counter_baseline');
    const result = processCounter(second, counter, rate, 'rate', initial.state, options);
    expect(result.output.observation.value && 'value' in result.output.observation.value ? result.output.observation.value.value : null).toBe(c.expected);
    expect(result.output.observation.quality.reason).toBe(c.reason);
    expect(() => validateObservation(result.output.observation, rate)).not.toThrow();
  });
});

const options = { context, max_gap_ms: 300000 };
function run(input: Observation, state: CounterState | null = null) { return processCounter(input, counter, rate, 'rate', state, options); }
describe('baseline transitions', () => {
  it('does not advance on duplicate/equal-time/late observations, even after a source switch', () => {
    const a = point('1000'), b = point('2000', 10000);
    const state = run(b, run(a).state).state;
    for (const input of [a, b, identify({ ...a, source: { ...a.source, collector_id: 'other' } }), identify({ ...b, source: { ...b.source, attempt_id: 'independent' } })]) {
      const result = run(input, state);
      expect(result.advanced).toBe(false);
      expect(result.state).toBe(state);
      expect(result.output.observation.value).toBeNull();
    }
    expect(run(point('3000', 20000), state).output.observation.value).toEqual({ encoding: 'float64', value: 800 });
  });
  it.each(['source', 'binding', 'transform', 'package', 'revision', 'restart', 'epoch', 'bits'] as const)('resets on %s changes', change => {
    const a = point('1000'), b = point('2000', 10000);
    if (change === 'source') b.source.collector_id = 'other';
    if (change === 'binding') b.source.metric_binding_id = 'other';
    if (change === 'transform') b.versions.transform_version = '1.0.1';
    if (change === 'package') b.versions.package_version = '1.0.1';
    if (change === 'revision') b.versions.config_revision++;
    if (change === 'restart') b.counter!.start_at = b.observed_at;
    if (change === 'epoch') b.counter!.discontinuity = { epoch: 'boot-2', reason: 'boot', observed_at: b.observed_at };
    if (change === 'bits') b.counter!.bits = '32';
    const result = run(identify(b), run(a).state);
    expect(result.output.observation.quality.reason).toBe('counter_reset');
    expect(result.advanced).toBe(true);
    expect(result.state!.baseline.id).toBe(identify(b).id);
  });
  it('switching back never resurrects the old source baseline', () => {
    const a = point('1000'), b = point('2000', 10000);
    b.source.collector_id = 'other';
    const changed = run(identify(b), run(a).state);
    expect(run(point('3000', 20000), changed.state).output.observation.quality.reason).toBe('counter_reset');
  });
  it('isolates dimensions and rejects cross-series state', () => {
    const a = point('1000'), b = identify({ ...point('2000', 10000), dimensions: { interface: 'fixture1', direction: 'in' } });
    expect(() => run(b, run(a).state)).toThrow('STATE_SERIES_MISMATCH');
    expect(run(b).output.observation.quality.reason).toBe('counter_baseline');
  });
  it('missing/invalid input does not poison a baseline; recovery uses actual elapsed time', () => {
    const a = point('1000'), missing = identify({ ...point('2000', 10000), value: null, quality: { status: 'unknown' as const, reason: 'source_error' as const } });
    const prior = run(a).state, failed = run(missing, prior);
    expect(failed.state).toBe(prior);
    expect(failed.output.observation.value).toBeNull();
    const result = run(point('3000', 20000), failed.state);
    expect(result.output.observation.value).toEqual({ encoding: 'float64', value: 800 });
    expect(result.output.window).toEqual({ from: a.observed_at, to: point('3000', 20000).observed_at });
    expect(() => validateLineage(result.output.observation, [a, point('3000', 20000)])).not.toThrow();
  });
  it('recovers after a gap using the new baseline', () => {
    const gap = run(point('2000', 400000), run(point('1000')).state);
    expect(gap.output.observation.quality.reason).toBe('gap');
    expect(run(point('3000', 410000), gap.state).output.observation.value).toEqual({ encoding: 'float64', value: 800 });
  });
  it('returns exact delta beyond Number safe integer range', () => {
    const delta: MetricDefinition = { ...rate, id: 'host.network.delta', unit: 'By', value_type: 'uint64' };
    const a = point('0'), b = point('9007199254740993', 60000);
    const initial = processCounter(a, counter, delta, 'delta', null, options);
    const result = processCounter(b, counter, delta, 'delta', initial.state, options);
    expect(result.output.observation.value).toEqual({ encoding: 'uint64', value: '9007199254740993' });
    expect(result.output.observation.accuracy).toBe('exact');
  });
  it('preserves precision through source-unit conversion before delta', () => {
    const seconds: MetricDefinition = { ...counter, id: 'host.counter.seconds', unit: 's' };
    const delta: MetricDefinition = { ...rate, id: 'host.delta.seconds', unit: 's' };
    function raw(value: string, ms: number): RawObservation {
      const { lineage: _lineage, ...o } = point(value, ms);
      return identify({ ...o, stage: 'raw', raw_field: 'ticks', metric: { id: seconds.id, semantic_version: '1.0.0' }, unit: 'ms' });
    }
    const a = raw('9007199254740993', 0), b = raw('9007199254741993', 10000);
    const first = processCounter(a, seconds, delta, 'delta', null, options);
    const result = processCounter(b, seconds, delta, 'delta', first.state, options);
    expect(result.output.observation.value).toEqual({ encoding: 'float64', value: 1 });
    expect(result.output.observation.accuracy).toBe('exact');
  });
  it('rejects invalid policies and already-derived gauges', () => {
    expect(() => processCounter(point('1'), counter, rate, 'rate', null, { ...options, max_gap_ms: 0 })).toThrow('COUNTER_GAP_POLICY');
    expect(() => processCounter(sample(definitions[0].id), definitions[0], rate, 'rate', null, options)).toThrow('CUMULATIVE_MONOTONIC_REQUIRED');
  });
  it('treats equivalent epoch timestamp encodings as the same period', () => {
    const a = point('1000'), b = point('2000', 10000);
    b.counter!.start_at = '2026-09-01T00:00:00.000Z';
    expect(run(identify(b), run(a).state).output.observation.value).toEqual({ encoding: 'float64', value: 800 });
  });
  it('continues after a proven wrap when the driver retains its evidence', () => {
    const a = identify({ ...point('4294967290'), counter: { ...point('1').counter!, bits: '32' as const } });
    const b = identify({ ...point('4', 1000), counter: { ...a.counter!, discontinuity: { epoch: 'wrap-1', reason: 'wrap' as const, observed_at: point('4', 1000).observed_at } } });
    const c = identify({ ...point('14', 2000), counter: b.counter });
    const bounded = { ...options, max_increment_per_second: '100' };
    const first = processCounter(a, counter, rate, 'rate', null, bounded);
    const wrapped = processCounter(b, counter, rate, 'rate', first.state, bounded);
    const next = processCounter(c, counter, rate, 'rate', wrapped.state, bounded);
    expect(next.output.observation.value).toEqual({ encoding: 'float64', value: 80 });
    expect(next.output.observation.quality.reason).toBe('none');
  });
});

describe('normalization and exact arithmetic', () => {
  it('normalizes equivalent time units without changing semantics', () => {
    const seconds = normalize(rawObservation, definitions[0], context);
    const milliseconds = normalize(identify({ ...rawObservation, unit: 'ms', value: { encoding: 'uint64', value: '3600000' } }), definitions[0], context);
    expect(milliseconds.observation.value).toEqual(seconds.observation.value);
    expect(milliseconds.observation.accuracy).toBe('exact');
    expect(() => validateLineage(milliseconds.observation, [identify({ ...rawObservation, unit: 'ms', value: { encoding: 'uint64', value: '3600000' } })])).not.toThrow();
  });
  it('rejects incompatible units even with a missing value', () => {
    expect(() => normalize(identify({ ...rawObservation, unit: 'By' }), definitions[0], context)).toThrow('UNIT_CONVERSION');
  });
  it('marks final lossy float encoding; never rounds an integer encoding', () => {
    const output = normalize(identify({ ...rawObservation, value: { encoding: 'uint64', value: '9007199254740993' } }), definitions[0], context);
    expect(output.observation.quality).toEqual({ status: 'partial', reason: 'precision_loss' });
    expect(output.observation.accuracy).toBe('estimated');
    expect(encode(rational(1n, 3n), 'uint64')).toEqual({ value: null, exact: false });
    expect(encode(rational(1n << 64n), 'uint64').value).toBeNull();
    expect(encode(rational(-(1n << 63n)), 'int64').exact).toBe(true);
  });
  it('rejects numeric raw counters instead of inventing integer precision', () => {
    const { lineage: _lineage, ...o } = point('9007199254740993');
    const raw: RawObservation = identify({ ...o, stage: 'raw', raw_field: 'counter', value: { encoding: 'float64', value: 9007199254740992 } });
    const normalized = normalize(raw, counter, context);
    expect(normalized.observation.value).toBeNull();
    expect(normalized.observation.quality).toEqual({ status: 'invalid', reason: 'precision_loss' });
    expect(run(raw).advanced).toBe(false);
  });
  it.each([0, -0, 0.25, -1.5, Number.MIN_VALUE, Number.MAX_VALUE])('preserves IEEE input %s', value => {
    const result = encode(decode({ encoding: 'float64', value }), 'float64');
    expect(result.exact).toBe(true);
    expect(result.value).toEqual({ encoding: 'float64', value: value === 0 ? 0 : value });
  });
});

function envelope(observation: ReturnType<typeof sample>): Computation {
  return { observation, window: { from: observation.observed_at, to: observation.observed_at }, freshness: 'fresh',
    input_provenance: [{ id: observation.id, stage: observation.stage, source: observation.source, versions: observation.versions, metric: observation.metric }] };
}
const used = () => envelope(sample('host.filesystem.used_bytes'));
const size = () => envelope(sample('host.filesystem.size_bytes'));
function execute(nodes: DerivedMetric[] = [derived], inputs = [used(), size()], catalog = definitions) {
  const anchor = used().observation;
  return executeDerived(nodes, catalog, inputs, { anchor, context, counter: { max_gap_ms: 300000 },
    targets: Object.fromEntries(nodes.map(n => [n.id, { source: { ...anchor.source, collector_id: `derived:${n.id}` }, versions: { ...anchor.versions, transform_version: n.transform_version } }])) });
}
describe('restricted derived DAG', () => {
  it('produces an exact ratio with validated lineage and worst freshness', () => {
    const a = used(), b = size(); a.freshness = 'stale';
    const result = execute([derived], [a, b]).outputs[0];
    expect(result.observation.value).toEqual({ encoding: 'float64', value: 0.25 });
    expect(result.observation.accuracy).toBe('exact');
    expect(result.observation.production).toBe('derived');
    expect(result.freshness).toBe('stale');
    expect(() => validateDerivedObservation(result.observation, [a.observation, b.observation], derived)).not.toThrow();
  });
  it('denominator zero and missing dependencies never become zero', () => {
    const zero = size(); zero.observation = identify({ ...zero.observation, value: { encoding: 'uint64', value: '0' } });
    const result = execute([derived], [used(), zero]).outputs[0];
    expect(result.observation.value).toBeNull();
    expect(result.observation.quality.reason).toBe('invalid_denominator');
    expect(execute([derived], [used()]).outputs[0].observation.quality.reason).toBe('missing_input');
    expect(execute([derived], []).outputs[0].observation.quality.reason).toBe('missing_input');
  });
  it.each(['estimated', 'unknown'] as const)('propagates %s accuracy without upgrading', accuracy => {
    const a = used(); a.observation = identify({ ...a.observation, accuracy });
    expect(execute([derived], [a, size()]).outputs[0].observation.accuracy).toBe(accuracy);
  });
  it('propagates invalid dependencies and their reason', () => {
    const a = used(); a.observation = identify({ ...a.observation, value: null, quality: { status: 'invalid', reason: 'source_error' } });
    expect(execute([derived], [a, size()]).outputs[0].observation.quality).toEqual({ status: 'invalid', reason: 'source_error' });
  });
  it('enforces skew and matching interval windows', () => {
    const a = used(), b = size(); b.observation = identify({ ...b.observation, observed_at: '2026-09-01T00:00:00Z' }); b.window = { from: b.observation.observed_at, to: b.observation.observed_at };
    expect(execute([derived], [a, b]).outputs[0].observation.quality.reason).toBe('clock_skew');
    const interval = used(); interval.window.from = '2026-09-01T00:00:00Z';
    expect(execute([derived], [interval, size()]).outputs[0].observation.quality.reason).toBe('gap');
  });
  it('sorts dependencies, computes percent, and propagates failure through the DAG', () => {
    const ratioDef = definitions.find(d => d.id === derived.output.id)!;
    const out: MetricDefinition = { ...ratioDef, id: 'linux.filesystem.double_ratio' };
    const scale: DerivedMetric = { ...derived, id: 'double', output: { id: out.id, semantic_version: '1.0.0' }, inputs: [derived.output], operation: 'scale', factor: 2 };
    const result = execute([scale, derived], [used(), size()], [...definitions, out]);
    expect(result.outputs.map(r => r.observation.value)).toEqual([{ encoding: 'float64', value: 0.25 }, { encoding: 'float64', value: 0.5 }]);
    expect(result.outputs[1].input_provenance.some(p => p.id === used().observation.id)).toBe(true);
    expect(execute([scale, derived], [used()], [...definitions, out]).outputs[1].observation.value).toBeNull();
    const percent: MetricDefinition = { ...ratioDef, id: 'linux.filesystem.used_percent', unit: '%' };
    expect(execute([{ ...derived, output: { id: percent.id, semantic_version: '1.0.0' } }], [used(), size()], [...definitions, percent]).outputs[0].observation.value).toEqual({ encoding: 'float64', value: 25 });
  });
  it('sum and difference preserve integer intermediates', () => {
    const out: MetricDefinition = { ...definitions[1], id: 'host.filesystem.free_bytes' };
    const node: DerivedMetric = { ...derived, output: { id: out.id, semantic_version: '1.0.0' }, operation: 'difference', inputs: [...derived.inputs].reverse() };
    expect(execute([node], [used(), size()], [...definitions, out]).outputs[0].observation.value).toEqual({ encoding: 'uint64', value: '805306368' });
    expect(execute([{ ...node, operation: 'sum' }], [used(), size()], [...definitions, out]).outputs[0].observation.value).toEqual({ encoding: 'uint64', value: '1342177280' });
  });
  it('rejects cycles, unknown dependencies, scripts, duplicate sources and cross-dimension joins', () => {
    expect(() => execute([{ ...derived, operation: 'scale', factor: 1, inputs: [derived.output] }])).toThrow('DERIVED_CYCLE');
    expect(() => execute([{ ...derived, inputs: [{ id: 'host.unknown', semantic_version: '1.0.0' }] }])).toThrow('UNKNOWN_METRIC');
    expect(() => execute([{ ...derived, operation: 'eval' as DerivedMetric['operation'] }])).toThrow();
    expect(() => execute([derived], [used(), used(), size()])).toThrow('DUPLICATE_SOURCE');
    const other = size(); other.observation = identify({ ...other.observation, dimensions: { ...other.observation.dimensions, mount: '/other' } });
    expect(() => execute([derived], [used(), other])).toThrow('DERIVED_JOIN');
    expect(() => execute(Array.from({ length: 257 }, () => derived))).toThrow('DAG_LIMIT');
    expect(() => execute([{ ...derived, inputs: [derived.inputs[0], derived.inputs[0]] }])).toThrow('DUPLICATE_DEPENDENCY');
  });
  it('rate nodes share the original baseline within one DAG evaluation', () => {
    const node: DerivedMetric = { ...derived, id: 'rate', output: { id: rate.id, semantic_version: '1.0.0' }, inputs: [{ id: counter.id, semantic_version: '1.0.0' }], operation: 'rate' };
    const rate2: MetricDefinition = { ...rate, id: 'host.network.rate_two' };
    const nodes = [node, { ...node, id: 'rate2', output: { id: rate2.id, semantic_version: '1.0.0' } }];
    const a = point('1000'), b = point('7000', 60000);
    const execution = { anchor: b, context, counter: { max_gap_ms: 300000 }, targets: Object.fromEntries(nodes.map(n => [n.id, { source: { ...b.source, collector_id: n.id }, versions: b.versions }])) };
    const initial = executeDerived(nodes, [counter, rate, rate2], [envelope(a)], execution);
    const state = initial.states.get(seriesIdentity(a))!;
    const result = executeDerived(nodes, [counter, rate, rate2], [envelope(b)], { ...execution, states: initial.states });
    expect(result.outputs.map(o => o.observation.value)).toEqual([{ encoding: 'float64', value: 800 }, { encoding: 'float64', value: 800 }]);
    expect(result.states.get(seriesIdentity(a))!.baseline.id).toBe(b.id);
    expect(state.baseline.id).toBe(a.id);
    const upgraded = nodes.map(n => ({ ...n, transform_version: '1.0.1' }));
    const targets = Object.fromEntries(upgraded.map(n => [n.id, { source: execution.targets[n.id].source, versions: { ...b.versions, transform_version: '1.0.1' } }]));
    const reset = executeDerived(upgraded, [counter, rate, rate2], [envelope(b)], { ...execution, targets, states: initial.states });
    expect(reset.outputs.every(o => o.observation.value === null && o.observation.quality.reason === 'counter_reset')).toBe(true);
  });
});
