/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R2 — the public contract of the native
 * template catalog and the binding flow (preview → trial → apply).
 *
 * These schemas are the single source of truth for three artifacts that must not
 * drift: the OpenAPI document, the generated client types, and the Fastify route
 * schema. Every shape below mirrors what the real handlers return; fields the
 * flow only carries through (the internal execution plan) stay open objects so a
 * documented envelope never silently drops data.
 */
import { z } from 'zod';
import {
  HashIdSchema, PackageCompositionEntrySchema, SourceChainSchema, TemplateIdSchema,
  TemplateParametersSchema, TemplatePinSchema, TemplateVersionStatusSchema, VersionNumberSchema,
} from './templates.js';
import { RefSchema } from '../../metrics/policy/model.js';

const Timestamp = z.iso.datetime();
const ResourceTypeSchema = z.enum(['instance', 'server', 'network_device']);
const ReleaseSchema = z.strictObject({
  id: z.string(), version: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const MetricRefOutSchema = z.strictObject({ id: z.string(), semantic_version: z.string() });
const ApplicabilitySchema = z.strictObject({
  attribute: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  supported_values: z.array(z.string()),
  status: z.enum(['supported', 'unsupported', 'unknown']),
});
const SettingsSchema = z.strictObject({
  enabled: z.boolean(), interval_ms: z.number(), timeout_ms: z.number(), stale_after_ms: z.number(),
  max_counter_gap_ms: z.number(), max_rows: z.number(), max_concurrency: z.number(), max_series_per_resource: z.number(),
});
const BudgetSchema = z.strictObject({
  estimate: z.literal(true), request_unit: z.literal('logical_reads'),
  estimated_series_upper_bound: z.number(), max_series_per_resource: z.number(), requests_per_hour_estimate: z.number(),
});
const ResolvedParameterSchema = z.strictObject({
  name: z.string(), type: z.enum(['number', 'integer', 'boolean', 'string']),
  default: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  override: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  effective: z.union([z.number(), z.string(), z.boolean()]),
  source: z.enum(['default', 'override']),
});
const ResolvedParametersSchema = z.strictObject({
  pin: TemplatePinSchema, parameters: z.array(ResolvedParameterSchema),
});

/** The catalog: persisted template identities and their immutable version heads. */
export const TemplateCatalogSchema = z.looseObject({
  templates: z.array(z.looseObject({
    template_id: TemplateIdSchema, name: z.string(), status: z.string(),
    current_published_version: z.number().int().positive().nullable(),
    versions: z.array(z.strictObject({
      version: VersionNumberSchema, content_hash: HashIdSchema, status: TemplateVersionStatusSchema,
    })),
  })),
  /** Opaque forward cursor; `null` is the last page. */
  next_cursor: z.string().nullable(),
});

/** One immutable version exactly as stored, with its composition and provenance. */
export const TemplateVersionDetailSchema = z.looseObject({
  template_id: TemplateIdSchema,
  version: VersionNumberSchema,
  status: TemplateVersionStatusSchema,
  content_hash: HashIdSchema,
  package_composition: z.array(PackageCompositionEntrySchema),
  items: z.array(z.looseObject({
    item_id: z.string(), version: VersionNumberSchema, display_name: z.string(),
    canonical_metric: MetricRefOutSchema, unit: z.string(), dimensions: z.record(z.string(), z.string()),
    collector_ref: z.looseObject({ package_release: z.string(), implementation_id: z.string() }),
  })),
  parameters: TemplateParametersSchema,
  source_chain: SourceChainSchema,
  published_at: Timestamp,
});

/** Re-pinning either publishes one new immutable version or reports the target unchanged. */
export const TemplateRepinResponseSchema = z.union([
  z.strictObject({ unchanged: z.literal(true), template_id: TemplateIdSchema, version: VersionNumberSchema }),
  z.looseObject({
    unchanged: z.literal(false), template_id: TemplateIdSchema,
    from_version: VersionNumberSchema, to_version: VersionNumberSchema, content_hash: HashIdSchema,
    changes: z.array(z.strictObject({
      item_id: z.string(),
      from: z.strictObject({ version: VersionNumberSchema, release: z.string(), implementation_id: z.string() }),
      to: z.strictObject({ version: VersionNumberSchema, release: z.string(), implementation_id: z.string() }),
      reason: z.literal('target_version_incompatible'),
    })),
    pin: TemplatePinSchema,
  }),
]);

const ItemViewSchema = z.strictObject({
  template_id: z.string(), item_id: z.string(), item_version: VersionNumberSchema,
  canonical_metric: MetricRefOutSchema, unit: z.string(), dimensions: z.record(z.string(), z.string()),
  release: ReleaseSchema, release_ref: z.string(), collector_id: z.string(), implementation_id: z.string(),
  enabled: z.boolean(),
  decision: z.enum(['collect', 'derive', 'disabled', 'unsupported', 'capability_unknown']),
  capability: z.enum(['supported', 'unsupported', 'unknown']),
});
const ExclusionSchema = z.looseObject({
  pin: TemplatePinSchema, template_id: z.string(), item_id: z.string(), item_version: VersionNumberSchema,
  release: ReleaseSchema, metric: MetricRefOutSchema,
  decision: z.enum(['disabled', 'unsupported', 'capability_unknown']),
  reason: z.enum(['settings_disabled', 'metric_disabled', 'capability_unsupported', 'capability_unknown']),
  blocking: z.boolean(),
});

/**
 * Recovery for one native apply intent. `committed` is the host's own operation
 * row (written with the binding revision and audit); `pending` is an unknown
 * outcome that must not be resent; `absent` proves no intent with that key was
 * recorded for this resource.
 */
export const TemplateOperationStateSchema = z.strictObject({
  state: z.enum(['committed', 'pending', 'absent']),
  operation: z.strictObject({
    resource: RefSchema, target_revision: z.number().int().positive(),
    candidate_digest: HashIdSchema, resolution_identity: HashIdSchema,
    status: z.enum(['committed', 'unknown', 'pending']),
  }).nullable(),
});

/**
 * The stored pending plan of a template binding. It is a plan, not an applied
 * configuration: `target_revision` becomes the published revision only when the
 * host transaction commits, and application is reported separately.
 */
export const TemplatePendingSchema = z.looseObject({  base_revision: z.number().int().nonnegative(),
  target_revision: z.number().int().positive(),
  resolution_identity: HashIdSchema,
  plan: z.looseObject({
    // Explicit keys: a record schema emits `propertyNames`, which Fastify's
    // strict response serializer cannot compile.
    settings: z.looseObject({ enabled: z.boolean(), interval_ms: z.number(), timeout_ms: z.number(),
      stale_after_ms: z.number(), max_counter_gap_ms: z.number(), max_rows: z.number(),
      max_concurrency: z.number(), max_series_per_resource: z.number() }),
    parameters: z.array(z.unknown()),
    releases: z.array(z.unknown()),
    excluded: z.array(z.unknown()),
  }),
  decided_at: Timestamp,
  operation_key: z.string(),
});

/**
 * The binding state of one resource; independent facts are never collapsed.
 * `configuration` is the stored per-resource choice itself — the exact override
 * set and group the binding was published with — so an editor can round-trip
 * every setting without re-deriving overrides from a resolved plan.
 */
export const TemplateBindingConfigurationSchema = z.strictObject({
  // An explicit loose object, not `z.record`: Fastify's response serializer
  // rejects a `propertyNames` keyword in strict mode, so a record schema turns
  // every status response into a 500. This one keeps arbitrary override keys.
  overrides: z.looseObject({}),
  group_id: z.string().nullable(),
});
export const TemplateBindingStatusSchema = z.looseObject({
  source: z.enum(['template', 'package', 'unbound']),
  revision: z.number().int().nonnegative().nullable(),
  application: z.strictObject({
    status: z.string(), applied_revision: z.number().int().nonnegative().nullable(),
    reported_at: Timestamp.nullable(), error_code: z.string().nullable(),
    /** The template application carries the identity it was applied for; a legacy row does not. */
    resolution_identity: HashIdSchema.nullable().optional(),
  }).nullable(),
  template_pins: z.array(TemplatePinSchema),
  pending: TemplatePendingSchema.nullable(),
  /** The stored per-resource configuration; null when this resource has no row. */
  configuration: TemplateBindingConfigurationSchema.nullable(),
  /** `resolution_identity` is null when the previous effective snapshot came from a package row. */
  effective: z.strictObject({ revision: z.number().int(), resolution_identity: z.string().nullable() }).nullable(),
  published_at: Timestamp.nullable(),
});

/** Preview: every item's decision, its exact release and why it applies (or not). */
export const TemplateBindingPreviewSchema = z.looseObject({
  template: z.literal(true),
  resource: RefSchema,
  revision: z.number().int().nonnegative(),
  resolution_identity: HashIdSchema,
  executable: z.boolean(),
  settings: SettingsSchema,
  parameters: z.array(ResolvedParametersSchema),
  releases: z.array(z.looseObject({
    release: ReleaseSchema, release_ref: z.string(), interval_ms: z.number(), timeout_ms: z.number(),
    collector_ids: z.array(z.string()), metric_keys: z.array(z.string()),
    requests_per_hour_estimate: z.number(), applicability: z.array(ApplicabilitySchema),
  })),
  items: z.array(ItemViewSchema),
  excluded: z.array(ExclusionSchema),
  budget: BudgetSchema,
  plan: z.looseObject({
    kind: z.literal('template_collection_plan'), internal: z.literal(true),
    persisted: z.literal(false), applied: z.literal(false), executable: z.boolean(),
    identity: HashIdSchema, resource: z.strictObject({ type: ResourceTypeSchema, id: z.string() }),
    revision: z.number().int().nonnegative(), settings: SettingsSchema,
    parameters: z.array(ResolvedParametersSchema),
    releases: z.array(z.unknown()), excluded: z.array(ExclusionSchema), budget: BudgetSchema,
  }),
});

/**
 * Bootstrap probe: the capability facts one bounded read-only probe observed for
 * an unbound resource and one exact candidate intent. It is not a trial, an
 * application or a binding; the same activation predicate still decides
 * enablement, and unknown/unsupported facts keep blocking it.
 */
export const TemplateProbeResponseSchema = z.looseObject({
  template: z.literal(true),
  resource: RefSchema,
  revision: z.number().int().nonnegative(),
  probed_at: Timestamp,
  expires_at: Timestamp,
  capabilities: z.array(z.strictObject({
    resource_id: z.string(), metric: MetricRefOutSchema,
    status: z.enum(['supported', 'unsupported', 'unknown']),
    method: z.enum(['sql', 'ssh', 'snmp', 'derived']),
    basis: z.array(z.strictObject({
      kind: z.enum(['resource', 'version', 'permission', 'method']), evidence: z.string().min(1),
    })).min(1),
    evaluated_at: Timestamp, valid_until: Timestamp,
  })).min(1),
});

/** Trial: real read-only evidence, never a formal observation and never persisted. */
export const TemplateTrialResponseSchema = z.looseObject({
  trial: z.literal(true),
  persisted: z.literal(false),
  decision: z.enum(['attempted', 'disabled', 'unsupported', 'capability_unknown']),
  receipt_id: z.string(),
  expires_at: Timestamp,
  resolution_identity: HashIdSchema,
  items: z.array(z.strictObject({
    template_id: z.string(), item_id: z.string(), item_version: VersionNumberSchema,
    phases: z.strictObject({ read: z.boolean(), transform: z.boolean(), unit: z.boolean() }),
  })),
  optional_exclusions: z.array(z.strictObject({
    template_id: z.string(), item_id: z.string(), item_version: VersionNumberSchema,
  })),
  samples: z.array(z.looseObject({
    template_id: z.string(), item_id: z.string(), item_version: VersionNumberSchema,
    metric: MetricRefOutSchema, value: z.unknown(), unit: z.string(), observed_at: Timestamp,
    quality: z.unknown(),
    read: z.looseObject({ collector_id: z.string(), attempt_ids: z.array(z.string()), status: z.string() }),
    transform: z.looseObject({ version: z.string() }),
    unit_check: z.looseObject({ input_unit: z.string(), output_unit: z.string() }),
  })),
  attempts: z.array(z.unknown()),
  releases: z.array(z.strictObject({ release_ref: z.string(), decision: z.string() })),
});

const OperationKeySchema = z.strictObject({ key: z.string(), caller_key: z.string() });

/** Apply: a staged binding is never reported as applied; an unknown is a lookup. */
export const TemplateBindingApplyResponseSchema = z.union([
  z.looseObject({ kind: z.literal('legacy_delegate') }),
  z.looseObject({
    kind: z.literal('replay'), persisted: z.literal(false),
    resource: RefSchema, base_revision: z.number().int(), target_revision: z.number().int(),
    candidate_digest: HashIdSchema,
    operation: OperationKeySchema.extend({ receipt_id: z.string(), status: z.literal('committed') }),
  }),
  z.looseObject({
    kind: z.literal('operation_lookup_required'), persisted: z.literal(false),
    resource: RefSchema, candidate_digest: HashIdSchema,
    operation: OperationKeySchema.extend({ status: z.literal('unknown') }),
  }),
  z.looseObject({
    kind: z.literal('rejected'), status: z.literal('rejected'), persisted: z.literal(false),
    committed: z.literal(false), code: z.string(),
  }),
  z.looseObject({
    kind: z.literal('committed'), status: z.literal('committed'), persisted: z.literal(true),
    committed: z.literal(true), revision: z.number().int().positive(),
    resolution_identity: HashIdSchema,
    operation: OperationKeySchema.extend({ receipt_id: z.string(), status: z.literal('committed') }),
  }),
  z.looseObject({
    kind: z.literal('rolled_back'), status: z.literal('rolled_back'),
    persisted: z.literal(false), committed: z.literal(false), code: z.string(),
  }),
  z.looseObject({
    kind: z.literal('commit_unknown'), status: z.literal('unknown'),
    persisted: z.literal('unknown'), committed: z.literal('unknown'), cause: z.string(), lookup: z.literal(true),
    operation: OperationKeySchema.extend({ status: z.literal('unknown') }),
  }),
]);

/** Request bodies: the raw candidate plus the trial receipt / idempotency key. */
export const TemplateBindingBodySchema = z.strictObject({
  /** The base the caller read; 0 is an unbound resource's first binding. */
  expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  template_pins: z.array(TemplatePinSchema).min(1),
  overrides: z.record(z.string(), z.unknown()).optional(),
  group_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
});
export const TemplateTrialBodySchema = TemplateBindingBodySchema.extend({ receipt_id: z.string() });
export const TemplateBindingApplyBodySchema = TemplateTrialBodySchema.extend({ caller_key: z.string() });
export const TemplateRepinBodySchema = z.strictObject({ resource: RefSchema });

export const TemplateUnbindPreviewRequestSchema = z.strictObject({
  expected_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expected_identity: HashIdSchema,
  remove_pins: z.array(TemplatePinSchema).max(256),
});
export const TemplateUnbindPreviewResponseSchema = z.strictObject({
  resource: RefSchema, revision: z.number().int().positive(), resolution_identity: HashIdSchema,
  removed_pins: z.array(TemplatePinSchema), remaining_pins: z.array(TemplatePinSchema),
  removed_items: z.array(z.strictObject({ pin: TemplatePinSchema, template_id: z.string(), item_id: z.string(),
    item_version: VersionNumberSchema, canonical_metric: MetricRefOutSchema, unit: z.string(),
    dimensions: z.looseObject({}), snapshot_decision: z.enum(['collect', 'disabled', 'unsupported', 'capability_unknown', 'unknown']),
    loses_provider: z.boolean(), remaining_providers: z.array(z.strictObject({
      template_id: z.string(), item_id: z.string(), item_version: VersionNumberSchema, pin: TemplatePinSchema,
      unit: z.string(), dimensions: z.looseObject({}),
      snapshot_decision: z.enum(['collect', 'disabled', 'unsupported', 'capability_unknown', 'unknown']),
    })) })),
  triggers: z.array(z.strictObject({ pin: TemplatePinSchema, template_id: z.string(), rule_id: z.string(),
    scope: z.string(), version: VersionNumberSchema })),
  configuration: TemplateBindingConfigurationSchema, history: z.literal('retained'),
  rule_effect: z.literal('references_only_unknown'),
});

/* --- immediate collection ------------------------------------------------- */

const CollectStateSchema = z.enum(['accepted', 'running', 'completed', 'failed', 'cancelled', 'unknown']);
const CollectOutcomeSchema = z.enum(['sampled', 'no_samples', 'failed', 'cancelled', 'unknown']);
const CallerKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
/** The client's idempotency key plus the exact published revision it saw. */
export const TemplateCollectRequestSchema = z.strictObject({
  caller_key: CallerKeySchema,
  expected_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
/**
 * One manual task. `state` is the task lifecycle and `samples` are only the
 * samples this task's own job committed: a completed task may carry zero samples
 * and never implies a successful collection on its own.
 */
export const TemplateCollectResponseSchema = z.strictObject({
  collect: z.literal(true),
  resource: RefSchema,
  caller_key: z.string(),
  state: z.union([CollectStateSchema, z.literal('absent')]),
  task: z.strictObject({
    id: z.string(), job_id: z.string(), state: CollectStateSchema,
    revision: z.number().int().positive(), resolution_identity: HashIdSchema,
    outcome: CollectOutcomeSchema.nullable(), error_code: z.string().nullable(),
    created_at: Timestamp, started_at: Timestamp.nullable(), finished_at: Timestamp.nullable(),
  }).nullable(),
  samples: z.array(z.strictObject({
    id: z.string(), metric: MetricRefOutSchema, unit: z.string(), value: z.unknown(),
    observed_at: Timestamp, quality: z.unknown(), attempt_ids: z.array(z.string()),
  })),
  attempts: z.array(z.strictObject({
    id: z.string(), collector_id: z.string().nullable(), status: z.string(),
  })),
});
