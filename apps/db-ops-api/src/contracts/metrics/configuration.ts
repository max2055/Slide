import { z } from 'zod';
import { DimensionsSchema, IdSchema, MetricRefSchema, ResourceTypeSchema, TimestampSchema, UnitSchema, VersionSchema } from './definitions.js';
import { CapabilitySchema, FreshnessSchema, NormalizedObservationSchema } from './observations.js';

export const CollectorDefinitionSchema = z.strictObject({
  id: IdSchema, method: z.enum(['sql', 'ssh', 'snmp']),
  implementation_ref: IdSchema,
  timeout_ms: z.number().int().positive(), estimated_cost: z.enum(['low', 'medium', 'high']),
  mappings: z.array(z.strictObject({
    metric: MetricRefSchema, raw_field: IdSchema, input_unit: UnitSchema, output_unit: UnitSchema,
    transform_version: VersionSchema,
    steps: z.array(z.enum(['decode', 'unit_convert', 'counter_delta', 'rate', 'derive', 'normalize'])).min(2),
  })).min(1),
});
export const CollectorPackageSchema = z.strictObject({
  id: IdSchema, version: VersionSchema, contract_version: VersionSchema,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resource_type: ResourceTypeSchema,
  applicability: z.array(z.strictObject({ attribute: IdSchema, values: z.array(z.string()).min(1) })).min(1),
  collectors: z.array(CollectorDefinitionSchema).min(1),
});
export const CollectionPolicySchema = z.strictObject({
  id: IdSchema, revision: z.number().int().positive(), enabled: z.boolean(),
  interval_ms: z.number().int().positive(), timeout_ms: z.number().int().positive(),
  stale_after_ms: z.number().int().positive(), max_counter_gap_ms: z.number().int().positive(),
  max_concurrency: z.number().int().positive(), max_series_per_resource: z.number().int().positive(),
});
export const CollectionBindingSchema = z.strictObject({
  id: IdSchema, resource_id: IdSchema, resource_type: ResourceTypeSchema,
  package: z.strictObject({ id: IdSchema, version: VersionSchema, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  policy_id: IdSchema, policy_revision: z.number().int().positive(), config_revision: z.number().int().positive(),
  enabled: z.boolean(),
});
export const MetricBindingSchema = z.strictObject({
  id: IdSchema, collection_binding_id: IdSchema, resource_id: IdSchema, metric: MetricRefSchema,
  dimensions: DimensionsSchema, enabled: z.boolean(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('collector'), collector_id: IdSchema, raw_field: IdSchema }),
    z.strictObject({ kind: z.literal('derived'), derived_id: IdSchema }),
  ]),
});
export const DerivedMetricSchema = z.strictObject({
  id: IdSchema, output: MetricRefSchema, transform_version: VersionSchema,
  inputs: z.array(MetricRefSchema).min(1),
  operation: z.enum(['difference', 'rate', 'ratio', 'sum', 'scale']),
  factor: z.number().optional(),
  join: z.literal('same_resource_and_dimensions'),
  max_skew_ms: z.number().int().nonnegative(),
  on_missing: z.literal('null'), on_zero_denominator: z.literal('null'),
  quality_propagation: z.literal('worst_input'), accuracy_propagation: z.literal('least_certain_input'),
});
export const AlertPolicySchema = z.strictObject({
  id: IdSchema, revision: z.number().int().positive(), enabled: z.boolean(), metric: MetricRefSchema,
  operator: z.enum(['gt', 'gte', 'lt', 'lte']), threshold: z.number(), unit: UnitSchema,
  for_ms: z.number().int().nonnegative(), min_coverage: z.number().min(0).max(1),
  accepted_quality: z.array(z.enum(['good', 'partial'])).min(1), allow_estimated: z.boolean(),
  on_missing: z.literal('unknown'),
});
export const CollectionPlanSchema = z.strictObject({
  binding: CollectionBindingSchema, policy: CollectionPolicySchema,
  resolved_at: TimestampSchema,
  entries: z.array(z.strictObject({
    binding: MetricBindingSchema, capability: CapabilitySchema,
    decision: z.enum(['collect', 'derive', 'disabled', 'unsupported', 'capability_unknown']),
  })),
});
export const MetricQuerySchema = z.strictObject({
  resource_type: ResourceTypeSchema, resource_id: IdSchema, metric: MetricRefSchema,
  dimensions: DimensionsSchema, from: TimestampSchema, to: TimestampSchema,
  limit: z.number().int().positive().max(10000), cursor: IdSchema.optional(),
});
export const MetricQueryResponseSchema = z.strictObject({
  contract_version: VersionSchema,
  series: z.array(z.strictObject({ observation: NormalizedObservationSchema, freshness: FreshnessSchema })),
  next_cursor: IdSchema.nullable(),
});
export type CollectorDefinition = z.infer<typeof CollectorDefinitionSchema>;
export type CollectorPackage = z.infer<typeof CollectorPackageSchema>;
export type CollectionPolicy = z.infer<typeof CollectionPolicySchema>;
export type CollectionBinding = z.infer<typeof CollectionBindingSchema>;
export type MetricBinding = z.infer<typeof MetricBindingSchema>;
export type DerivedMetric = z.infer<typeof DerivedMetricSchema>;
export type AlertPolicy = z.infer<typeof AlertPolicySchema>;
export type CollectionPlan = z.infer<typeof CollectionPlanSchema>;
export type MetricQuery = z.infer<typeof MetricQuerySchema>;
export type MetricQueryResponse = z.infer<typeof MetricQueryResponseSchema>;
