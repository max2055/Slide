import { z } from 'zod';
import { DimensionsSchema, IdSchema, MetricRefSchema, ResourceTypeSchema, TimestampSchema, UnitSchema, VersionSchema } from './definitions.js';

export const UnsignedIntegerSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const SignedIntegerSchema = z.string().regex(/^(0|-?[1-9]\d*)$/);
export const ScalarValueSchema = z.discriminatedUnion('encoding', [
  z.strictObject({ encoding: z.literal('float64'), value: z.number() }),
  z.strictObject({ encoding: z.literal('int64'), value: SignedIntegerSchema }),
  z.strictObject({ encoding: z.literal('uint64'), value: UnsignedIntegerSchema }),
]);
export const HistogramValueSchema = z.strictObject({
  encoding: z.literal('histogram'), count: UnsignedIntegerSchema, sum: z.number(),
  buckets: z.array(z.strictObject({ upper_bound: z.union([z.number(), z.literal('+Inf')]), count: UnsignedIntegerSchema })).min(1),
});
export const SummaryValueSchema = z.strictObject({
  encoding: z.literal('summary'), count: UnsignedIntegerSchema, sum: z.number(),
  quantiles: z.array(z.strictObject({ quantile: z.number().min(0).max(1), value: z.number() })).min(1),
});
export const MetricValueSchema = z.union([ScalarValueSchema, HistogramValueSchema, SummaryValueSchema]);
export const QualitySchema = z.strictObject({
  status: z.enum(['good', 'partial', 'unknown', 'invalid']),
  reason: z.enum(['none', 'partial_input', 'legacy_unknown', 'counter_baseline', 'counter_reset', 'counter_wrap', 'gap', 'missing_input', 'invalid_denominator', 'precision_loss', 'source_error', 'clock_skew', 'cardinality_exceeded']),
});
export const AccuracySchema = z.enum(['exact', 'estimated', 'unknown']);
export const ProductionSchema = z.enum(['measured', 'derived']);
export const CapabilitySchema = z.strictObject({
  resource_id: IdSchema, metric: MetricRefSchema,
  status: z.enum(['supported', 'unsupported', 'unknown']),
  method: z.enum(['sql', 'ssh', 'snmp', 'derived']),
  basis: z.array(z.strictObject({ kind: z.enum(['resource', 'version', 'permission', 'method']), evidence: z.string().min(1) })).min(1),
  evaluated_at: TimestampSchema, valid_until: TimestampSchema,
});
export const CollectionAttemptSchema = z.strictObject({
  id: IdSchema, resource_id: IdSchema, binding_id: IdSchema, collector_id: IdSchema,
  config_revision: z.number().int().positive(), started_at: TimestampSchema, ended_at: TimestampSchema.optional(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed', 'cancelled']),
  error: z.enum(['timeout', 'permission_denied', 'connection_error', 'parse_error', 'cancelled']).nullable(),
  observation_ids: z.array(IdSchema),
});
export const CounterEvidenceSchema = z.strictObject({
  start_at: TimestampSchema.optional(),
  discontinuity: z.strictObject({ epoch: IdSchema, observed_at: TimestampSchema, reason: z.enum(['boot', 'reset', 'wrap', 'source_change', 'initial']) }).optional(),
  bits: z.enum(['32', '64']),
});
export const ObservationRefSchema = z.strictObject({
  id: IdSchema, stage: z.enum(['raw', 'normalized']),
});
const identity = {
  id: IdSchema, resource_type: ResourceTypeSchema, resource_id: IdSchema,
  metric: MetricRefSchema, dimensions: DimensionsSchema,
  observed_at: TimestampSchema, collected_at: TimestampSchema, stored_at: TimestampSchema.nullable(),
  quality: QualitySchema, accuracy: AccuracySchema, production: ProductionSchema,
  source: z.strictObject({ binding_id: IdSchema, metric_binding_id: IdSchema, collector_id: IdSchema, attempt_id: IdSchema }),
  versions: z.strictObject({ contract: VersionSchema, package_id: IdSchema, package_version: VersionSchema, transform_version: VersionSchema, config_revision: z.number().int().positive() }),
  counter: CounterEvidenceSchema.optional(),
};
export const RawObservationSchema = z.strictObject({
  ...identity, stage: z.literal('raw'), unit: UnitSchema, value: MetricValueSchema.nullable(),
  raw_field: z.string().min(1),
});
export const NormalizedObservationSchema = z.strictObject({
  ...identity, stage: z.literal('normalized'), unit: UnitSchema, value: MetricValueSchema.nullable(),
  lineage: z.array(ObservationRefSchema).min(1),
});
export const FreshnessSchema = z.enum(['fresh', 'stale', 'unknown']);
export const AggregationRequestSchema = z.strictObject({
  resource_type: ResourceTypeSchema, resource_id: IdSchema, dimensions: DimensionsSchema,
  metric: MetricRefSchema, operation: z.enum(['last', 'min', 'max', 'mean', 'sum', 'rate', 'merge', 'quantile']),
  input: z.enum(['samples', 'histogram', 'summary_quantile']),
  from: TimestampSchema, to: TimestampSchema, missing: z.literal('preserve_null'),
  quantile: z.number().min(0).max(1).optional(),
});
export const AggregatedObservationSchema = z.strictObject({
  request: AggregationRequestSchema, value: MetricValueSchema.nullable(), quality: QualitySchema,
  accuracy: AccuracySchema, coverage: z.number().min(0).max(1), sample_count: UnsignedIntegerSchema,
  input_ids: z.array(IdSchema),
});
export type Capability = z.infer<typeof CapabilitySchema>;
export type CollectionAttempt = z.infer<typeof CollectionAttemptSchema>;
export type RawObservation = z.infer<typeof RawObservationSchema>;
export type NormalizedObservation = z.infer<typeof NormalizedObservationSchema>;
export type MetricValue = z.infer<typeof MetricValueSchema>;
export type Quality = z.infer<typeof QualitySchema>;
export type Accuracy = z.infer<typeof AccuracySchema>;
export type AggregationRequest = z.infer<typeof AggregationRequestSchema>;
export type AggregatedObservation = z.infer<typeof AggregatedObservationSchema>;
