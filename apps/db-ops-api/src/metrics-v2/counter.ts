import { seriesIdentity, validateDefinition, validateObservation, type MetricDefinition, type Quality } from '../contracts/metrics-v2/index.js';
import { compare, decode, divide, multiply, rational, subtract, unitFactor } from './arithmetic.js';
import { buildOutput, evaluateContext, type Computation, type Evaluation, type Observation } from './observation.js';
import type { CounterState } from './state.js';

export interface CounterOptions {
  context: Evaluation;
  max_gap_ms: number;
  /** Trusted driver bound in RAW input units per second; never inferred from observed rates. */
  max_increment_per_second?: string;
  /** Pinned consumer plan/formula identity; changes invalidate the baseline. */
  processing_revision?: string;
}
export interface CounterTransition { state: CounterState | null; advanced: boolean; output: Computation }
function sourceSegment(o: Observation): string {
  return JSON.stringify([o.source.binding_id, o.source.metric_binding_id, o.source.collector_id,
    o.versions.contract, o.versions.package_id, o.versions.package_version, o.versions.transform_version,
    o.versions.config_revision, o.unit, o.counter?.bits]);
}
function period(o: Observation): string {
  const evidence = o.counter?.discontinuity;
  return JSON.stringify([o.counter?.start_at ? Date.parse(o.counter.start_at) : null,
    evidence?.epoch, evidence ? Date.parse(evidence.observed_at) : null, evidence?.reason]);
}
export function processCounter(input: Observation, definition: MetricDefinition, outputDefinition: MetricDefinition,
  operation: 'delta' | 'rate', state: CounterState | null, options: CounterOptions): CounterTransition {
  validateObservation(input, definition);
  validateDefinition(outputDefinition);
  evaluateContext(options.context);
  if (operation !== 'delta' && operation !== 'rate') throw new Error('COUNTER_OPERATION');
  if (definition.kind !== 'counter' || definition.temporality !== 'cumulative' || !definition.monotonic) throw new Error('CUMULATIVE_MONOTONIC_REQUIRED');
  if (outputDefinition.kind !== 'gauge' || outputDefinition.resource_type !== definition.resource_type) throw new Error('COUNTER_OUTPUT');
  if (!Number.isSafeInteger(options.max_gap_ms) || options.max_gap_ms <= 0) throw new Error('COUNTER_GAP_POLICY');
  if (options.max_increment_per_second !== undefined && !/^(0|[1-9]\d*)$/.test(options.max_increment_per_second)) throw new Error('COUNTER_BOUND');
  const factor = unitFactor(input.unit, definition.unit);
  const rateUnits: Record<string, string> = { By: 'By/s', count: 'count/s' };
  const outputFactor = operation === 'delta' ? unitFactor(definition.unit, outputDefinition.unit)
    : unitFactor((rateUnits[definition.unit] ?? 'unsupported') as MetricDefinition['unit'], outputDefinition.unit);
  const series = seriesIdentity(input), segment = sourceSegment(input);
  const processingRevision = JSON.stringify([options.processing_revision ?? input.versions.transform_version,
    options.max_gap_ms, options.max_increment_per_second ?? null]);
  if (state && state.series !== series) throw new Error('STATE_SERIES_MISMATCH');
  if (state) {
    validateObservation(state.baseline, definition);
    if (seriesIdentity(state.baseline) !== state.series || sourceSegment(state.baseline) !== state.segment) throw new Error('STATE_CORRUPT');
  }
  const previous = state?.baseline;
  const next: CounterState = { series, segment, processing_revision: processingRevision, baseline: structuredClone(input) };
  const finish = (quality: Quality | undefined, value: ReturnType<typeof rational> | null, advance: boolean, paired = false): CounterTransition => ({
    state: advance ? next : state, advanced: advance,
    output: buildOutput({ anchor: input, definition: outputDefinition, inputs: paired && previous ? [previous, input] : [input],
      value, quality, derived: true, context: options.context,
      window: { from: paired && previous ? previous.observed_at : input.observed_at, to: input.observed_at } }),
  });
  if (previous && Date.parse(input.observed_at) <= Date.parse(previous.observed_at)) return finish({ status: 'unknown', reason: 'clock_skew' }, null, false);
  if (!input.value || ['unknown', 'invalid'].includes(input.quality.status)) return finish(input.quality, null, false);
  // A rounded cumulative counter cannot become a trustworthy online baseline.
  if (input.quality.reason === 'precision_loss' || !('value' in input.value) || input.value.encoding === 'float64') return finish({ status: 'invalid', reason: 'precision_loss' }, null, false);
  if (!previous) return finish({ status: 'unknown', reason: 'counter_baseline' }, null, true);
  if (state!.segment !== segment || state!.processing_revision !== processingRevision) return finish({ status: 'unknown', reason: 'counter_reset' }, null, true);
  const elapsed = Date.parse(input.observed_at) - Date.parse(previous.observed_at);
  const evidence = input.counter!.discontinuity;
  const wrapEvidence = evidence?.reason === 'wrap' && Date.parse(evidence.observed_at) > Date.parse(previous.observed_at)
    && Date.parse(evidence.observed_at) <= Date.parse(input.observed_at)
    && (input.counter!.start_at ? Date.parse(input.counter!.start_at) : null) === (previous.counter!.start_at ? Date.parse(previous.counter!.start_at) : null);
  if (period(input) !== period(previous) && !wrapEvidence) return finish({ status: 'unknown', reason: 'counter_reset' }, null, true);
  if (elapsed > options.max_gap_ms) return finish({ status: 'unknown', reason: 'gap' }, null, true, true);
  if (!previous.value) throw new Error('STATE_BASELINE_VALUE');
  let rawDelta = subtract(decode(input.value), decode(previous.value));
  let wrapped = false;
  if (input.counter!.bits === '32') {
    const modulus = rational(1n << 32n);
    const bound = options.max_increment_per_second === undefined ? null
      : rational(BigInt(options.max_increment_per_second) * BigInt(elapsed), 1000n);
    // Requiring a sub-modulus bound also rejects invisible multiple wraps with an increasing value.
    if (!bound || compare(bound, modulus) >= 0) return finish({ status: 'unknown', reason: 'counter_reset' }, null, true, true);
    if (rawDelta.numerator < 0n && wrapEvidence) {
      rawDelta = rational(rawDelta.numerator + (1n << 32n) * rawDelta.denominator, rawDelta.denominator);
      wrapped = true;
    } else if (wrapEvidence) return finish({ status: 'unknown', reason: 'counter_reset' }, null, true, true);
    if (compare(rawDelta, bound) > 0) return finish({ status: 'unknown', reason: 'counter_reset' }, null, true, true);
  } else if (wrapEvidence) return finish({ status: 'unknown', reason: 'counter_reset' }, null, true, true);
  if (rawDelta.numerator < 0n) return finish({ status: 'unknown', reason: 'counter_reset' }, null, true, true);
  // Equivalent to converting both endpoints before subtraction, with exact rational intermediates.
  let value = multiply(rawDelta, factor);
  if (operation === 'rate') value = divide(value, rational(BigInt(elapsed), 1000n));
  value = multiply(value, outputFactor);
  return finish(wrapped ? { status: 'partial', reason: 'counter_wrap' } : undefined, value, true, true);
}
