import {
  freshness, observationIdentity, propagateQuality, validateObservation,
  type MetricDefinition, type NormalizedObservation, type RawObservation, type Quality,
} from '../contracts/metrics-v2/index.js';
import { decode, encode, multiply, unitFactor, type Rational } from './arithmetic.js';

export type Observation = RawObservation | NormalizedObservation;
export type Window = { from: string; to: string };
export type Evaluation = { now: string; stale_after_ms: number };
export type InputProvenance = Pick<Observation, 'id' | 'stage' | 'source' | 'versions' | 'metric'>;
/** Metadata not present in the frozen observation wire schema stays in this envelope. */
export interface Computation {
  observation: NormalizedObservation;
  window: Window;
  freshness: 'fresh' | 'stale' | 'unknown';
  input_provenance: InputProvenance[];
}
export function evaluateContext(context: Evaluation): void {
  if (!Number.isFinite(Date.parse(context.now)) || !Number.isSafeInteger(context.stale_after_ms) || context.stale_after_ms <= 0) throw new Error('EVALUATION_CONTEXT');
}
export function buildOutput(args: {
  anchor: Observation; definition: MetricDefinition; inputs: Observation[];
  value: Rational | null; context: Evaluation; window: Window;
  quality?: Quality; derived?: boolean;
  source?: Observation['source']; versions?: Observation['versions'];
}): Computation {
  evaluateContext(args.context);
  const propagated = propagateQuality(args.inputs);
  const rank = { good: 0, partial: 1, unknown: 2, invalid: 3 };
  let quality = args.quality && rank[args.quality.status] >= rank[propagated.quality.status] ? args.quality : propagated.quality;
  let accuracy = propagated.accuracy;
  const encoded = args.value === null ? { value: null, exact: true } : encode(args.value, args.definition.value_type);
  if (!encoded.exact) {
    accuracy = accuracy === 'unknown' ? 'unknown' : 'estimated';
    const loss: Quality = { status: encoded.value ? 'partial' : 'invalid', reason: 'precision_loss' };
    if (rank[loss.status] >= rank[quality.status]) quality = loss;
  }
  if (quality.reason === 'precision_loss' && accuracy === 'exact') accuracy = 'estimated';
  const value = ['unknown', 'invalid'].includes(quality.status) ? null : encoded.value;
  const times = args.inputs.length ? args.inputs : [args.anchor];
  const latest = (key: 'observed_at' | 'collected_at') => new Date(Math.max(...times.map(i => Date.parse(i[key])))).toISOString();
  const output: NormalizedObservation = {
    id: 'pending', stage: 'normalized', resource_type: args.definition.resource_type,
    resource_id: args.anchor.resource_id, metric: { id: args.definition.id, semantic_version: args.definition.semantic_version },
    dimensions: { ...args.anchor.dimensions }, observed_at: latest('observed_at'), collected_at: latest('collected_at'), stored_at: null,
    unit: args.definition.unit, value, quality, accuracy, production: args.derived ? 'derived' : args.anchor.production,
    source: { ...(args.source ?? args.anchor.source) }, versions: { ...(args.versions ?? args.anchor.versions) },
    ...(args.definition.kind === 'counter' && args.anchor.counter ? { counter: structuredClone(args.anchor.counter) } : {}),
    lineage: [...new Map(times.map(i => [`${i.stage}:${i.id}`, { id: i.id, stage: i.stage }])).values()],
  };
  output.id = observationIdentity(output);
  validateObservation(output, args.definition);
  const ages = times.map(i => freshness(i.observed_at, args.context.now, args.context.stale_after_ms));
  return {
    observation: output, window: { ...args.window },
    freshness: ages.includes('unknown') ? 'unknown' : ages.includes('stale') ? 'stale' : 'fresh',
    input_provenance: times.map(i => structuredClone({ id: i.id, stage: i.stage, source: i.source, versions: i.versions, metric: i.metric })),
  };
}
export function normalize(raw: RawObservation, definition: MetricDefinition, context: Evaluation): Computation {
  validateObservation(raw, definition);
  const factor = unitFactor(raw.unit, definition.unit);
  if (definition.kind === 'counter' && raw.value?.encoding === 'float64') {
    return buildOutput({ anchor: raw, definition, inputs: [raw], value: null,
      quality: { status: 'invalid', reason: 'precision_loss' }, context, window: { from: raw.observed_at, to: raw.observed_at } });
  }
  return buildOutput({ anchor: raw, definition, inputs: [raw], value: raw.value ? multiply(decode(raw.value), factor) : null,
    context, window: { from: raw.observed_at, to: raw.observed_at } });
}
