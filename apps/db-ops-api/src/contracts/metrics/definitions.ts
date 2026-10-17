import { z } from 'zod';

export const CONTRACT_VERSION = '1.0.0' as const;
export const VersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const IdSchema = z.string().min(1).max(256);
export const TimestampSchema = z.iso.datetime().regex(/:\d{2}(?:\.\d{1,3})?Z$/);
export const MetricIdSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
export const ResourceTypeSchema = z.enum(['instance', 'server', 'network_device']);
export const MetricKindSchema = z.enum(['gauge', 'counter', 'histogram', 'summary']);
export const MetricRoleSchema = z.enum(['core', 'diagnostic', 'capacity', 'slo']);
export const UnitSchema = z.enum(['1', 'By', 's', 'ms', '%', 'bit/s', 'By/s', 'count', 'count/s']);
export const DimensionSchema = z.strictObject({
  keys: z.array(z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    meaning: z.string().min(1),
    required: z.boolean(),
    allowed_values: z.array(z.string().min(1)).min(1).optional(),
  })),
  max_series_per_resource: z.number().int().positive(),
  max_value_length: z.number().int().positive().max(1024),
  overflow: z.literal('reject'),
});
export const DimensionsSchema = z.record(z.string(), z.string().min(1));
export const AggregationPolicySchema = z.strictObject({
  time: z.array(z.enum(['last', 'min', 'max', 'mean', 'sum', 'rate', 'merge', 'quantile'])).min(1),
  space: z.array(z.enum(['none', 'sum', 'min', 'max', 'weighted_mean', 'merge'])).min(1),
  missing: z.literal('preserve_null'),
  min_coverage: z.number().min(0).max(1),
  quantiles: z.enum(['not_applicable', 'from_merged_histogram', 'non_mergeable']),
});
const definition = {
  id: MetricIdSchema,
  semantic_version: VersionSchema,
  meaning: z.string().min(1),
  unit: UnitSchema,
  resource_type: ResourceTypeSchema,
  scope: z.enum(['resource', 'database', 'filesystem', 'interface']),
  kind: MetricKindSchema,
  roles: z.array(MetricRoleSchema).min(1),
  temporality: z.enum(['instant', 'cumulative', 'delta']),
  monotonic: z.boolean(),
  value_type: z.enum(['float64', 'int64', 'uint64', 'histogram', 'summary']),
  dimensions: DimensionSchema,
  aggregation: AggregationPolicySchema,
  lifecycle: z.enum(['active', 'deprecated']),
  replacement_id: MetricIdSchema.optional(),
};
export const CanonicalMetricDefinitionSchema = z.strictObject({ ...definition, category: z.literal('canonical') });
export const ExtensionMetricDefinitionSchema = z.strictObject({
  ...definition, category: z.literal('extension'),
  namespace: z.string().regex(/^[a-z][a-z0-9_]*$/),
});
export const MetricDefinitionSchema = z.discriminatedUnion('category', [CanonicalMetricDefinitionSchema, ExtensionMetricDefinitionSchema]);
export const ResourceSchema = z.strictObject({
  type: ResourceTypeSchema, id: IdSchema,
  attributes: z.record(z.string(), z.strictObject({
    value: z.union([z.string(), z.number(), z.boolean()]), observed_at: TimestampSchema, source: IdSchema,
  })),
});
export const MetricRefSchema = z.strictObject({ id: MetricIdSchema, semantic_version: VersionSchema });
export const CoreProfileSchema = z.strictObject({
  id: IdSchema, version: VersionSchema, resource_type: ResourceTypeSchema,
  columns: z.array(z.strictObject({ key: IdSchema, label: z.string().min(1), metric: MetricRefSchema })).min(1),
  owner: z.literal('product'),
});
export const MetricAliasSchema = z.strictObject({
  alias: MetricIdSchema, target: MetricRefSchema, reason: z.string().min(1),
});
export type MetricKind = z.infer<typeof MetricKindSchema>;
export type MetricRole = z.infer<typeof MetricRoleSchema>;
export type DimensionSchema = z.infer<typeof DimensionSchema>;
export type AggregationPolicy = z.infer<typeof AggregationPolicySchema>;
export type CanonicalMetricDefinition = z.infer<typeof CanonicalMetricDefinitionSchema>;
export type ExtensionMetricDefinition = z.infer<typeof ExtensionMetricDefinitionSchema>;
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type CoreProfile = z.infer<typeof CoreProfileSchema>;
export type MetricAlias = z.infer<typeof MetricAliasSchema>;
