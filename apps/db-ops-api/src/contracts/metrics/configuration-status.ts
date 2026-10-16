import { z } from 'zod';

const timestamp = z.iso.datetime().nullable();
const revision = z.number().int().positive().nullable();
const metric = z.strictObject({ id: z.string(), semantic_version: z.string() });
export const MetricConfigurationStatusSchema = z.strictObject({
  contract_version: z.literal('1.0.0'),
  resource: z.strictObject({ type: z.enum(['instance', 'server', 'network_device']), id: z.number().int().positive() }),
  evaluated_at: z.iso.datetime(), can_manage: z.boolean(),
  binding: z.strictObject({ state: z.enum(['bound', 'unbound']),
    package: z.strictObject({ id: z.string(), version: z.string(), digest: z.string() }).nullable(),
    published_revision: revision, applied_revision: revision,
    application: z.enum(['unbound', 'pending', 'applied', 'failed']) }),
  effective_enabled: z.strictObject({ enabled: z.boolean(), global_enabled: z.boolean(), asset_enabled: z.boolean(), policy_enabled: z.boolean(),
    source: z.enum(['global', 'asset', 'package', 'platform', 'group', 'resource', 'unbound']) }),
  collection: z.strictObject({ state: z.enum(['disabled', 'pending', 'running', 'succeeded', 'failed', 'unknown']),
    last_attempt_at: timestamp, last_success_at: timestamp, in_flight: z.boolean() }),
  formal_visibility: z.strictObject({ state: z.enum(['unbound', 'pending', 'validating', 'available', 'failed']),
    source: z.enum(['none', 'semantic']), last_observed_at: timestamp, generation: revision,
    freshness: z.enum(['fresh', 'stale', 'unknown']) }),
  coverage: z.array(z.strictObject({ metric, state: z.enum(['covered', 'not_covered', 'unsupported', 'unknown', 'disabled']), reason: z.string().nullable() })),
  blockers: z.array(z.enum(['UNBOUND', 'GLOBAL_COLLECTION_DISABLED', 'ASSET_COLLECTION_DISABLED', 'POLICY_COLLECTION_DISABLED',
    'APPLICATION_PENDING', 'APPLICATION_FAILED', 'PACKAGE_INCOMPATIBLE', 'CAPABILITY_UNKNOWN', 'COLLECTION_FAILED',
    'SOURCE_VALIDATION_PENDING', 'SOURCE_VALIDATION_FAILED', 'AWAITING_SAMPLE', 'STALE_SAMPLE'])),
});
export type MetricConfigurationStatus = z.infer<typeof MetricConfigurationStatusSchema>;
