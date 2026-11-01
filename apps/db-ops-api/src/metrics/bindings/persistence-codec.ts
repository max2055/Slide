/**
 * MAX-238 / B2E — strict persistence codec for the per-resource binding row.
 *
 * One physical row (`metric_policy_bindings.payload`) carries either the legacy
 * single-package `Published` value (with no envelope, or the explicit
 * `package-v1` one) or the template `templates-v1` envelope. This module is the
 * only place that decides which one a stored payload is, validates every field
 * of both forms, and builds the next pending payload while preserving the
 * previously effective snapshot. A stored snapshot is only accepted as evidence
 * after it validates as the actual resolved view (`CollectionPlanSchema`, the
 * legacy `Resolved` shape, the B2C `TemplateCollectionPlan` shape) of *this*
 * resource and revision; kind/identity labels alone never prove one. It never
 * talks to a database, never mutates its input, and never echoes a payload or a
 * driver message in an error: every failure is a stable machine code.
 *
 * It is still **unmounted**: no reader, store, route or scheduler imports it in
 * this package. `bindingPayloadSource` is the minimal fence a legacy reader can
 * call before decoding; changing that reader is a later wiring package.
 */
import { z } from 'zod';
import { stable } from '../packages/model.js';
import {
  CapabilitySchema, CollectionPlanSchema, DimensionsSchema, IdSchema, MetricRefSchema,
  ResourceTypeSchema, TimestampSchema, UnitSchema, VersionSchema,
} from '../../contracts/metrics/index.js';
import {
  HashIdSchema, ItemIdSchema, PackageReleaseRefSchema, ParameterNameSchema, ParameterValueSchema,
  ResourceBindingCandidateSchema, TemplateIdSchema, TemplatePinSchema, TemplateTriggerRefSchema,
  VersionNumberSchema,
  type HashId, type ResourceBindingCandidate,
} from '../../contracts/metrics/templates.js';
import type { TemplateCollectionPlan } from './plan.js';

/** The storage discriminant of the template form. It lives at the top level only. */
export const BINDING_PAYLOAD_ENVELOPE = 'templates-v1';
/** A successful normal formal commit, with an explicit base→target plan mapping. */
export const BINDING_APPLIED_ENVELOPE = 'templates-applied-v1';
const FormalCommitSchema = z.strictObject({
  sample_ids: z.array(z.string().min(1).max(255)).min(1),
  attempt_ids: z.array(z.string().min(1).max(255)).min(1),
  at: TimestampSchema,
});
/**
 * The admitted explicit form of the legacy single-package payload. Its content is
 * exactly the no-envelope `Published` value; the envelope only states the source.
 */
export const BINDING_PAYLOAD_PACKAGE_ENVELOPE = 'package-v1';

export type BindingPersistenceErrorCode =
  | 'BINDING_PAYLOAD_INVALID_JSON'
  | 'BINDING_PAYLOAD_NOT_OBJECT'
  | 'BINDING_PAYLOAD_UNKNOWN_ENVELOPE'
  | 'BINDING_PAYLOAD_SHAPE_INVALID'
  | 'BINDING_PAYLOAD_AMBIGUOUS_SOURCE'
  | 'BINDING_PAYLOAD_MISSING_SOURCE'
  | 'BINDING_PAYLOAD_LEGACY_INVALID'
  | 'BINDING_PAYLOAD_BINDING_INVALID'
  | 'BINDING_PAYLOAD_PENDING_INVALID'
  | 'BINDING_PAYLOAD_APPLICATION_INVALID'
  | 'BINDING_PAYLOAD_REVISION_INVALID'
  | 'BINDING_PAYLOAD_IDENTITY_MISMATCH'
  | 'BINDING_PAYLOAD_PLAN_INVALID'
  | 'BINDING_PAYLOAD_EFFECTIVE_INVALID';

export class BindingPersistenceError extends Error {
  constructor(public readonly code: BindingPersistenceErrorCode) {
    super(code);
    this.name = 'BindingPersistenceError';
  }
}

const fail = (code: BindingPersistenceErrorCode): never => {
  throw new BindingPersistenceError(code);
};

const MAX_REVISION = Number.MAX_SAFE_INTEGER;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};

const RevisionSchema = z.number().int().nonnegative().max(MAX_REVISION);
const TargetRevisionSchema = z.number().int().positive().max(MAX_REVISION);
const PositiveSchema = z.number().int().positive();
const CountSchema = z.number().int().nonnegative();
const OperationKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:#@-]{0,1023}$/);

// --- stored snapshot shapes -------------------------------------------------
//
// A stored effective snapshot is only evidence when it is the *actual* value the
// accepted resolver wrote, so these reuse the existing contracts wherever one
// exists (`CollectionPlanSchema` above all) and only add the thin shapes the
// contracts describe as plain types.

/** The eight resource settings, in the shape `policy/resolver.ts` returns. */
const SettingsSchema = z.strictObject({
  enabled: z.boolean(),
  interval_ms: PositiveSchema,
  timeout_ms: PositiveSchema,
  stale_after_ms: PositiveSchema,
  max_counter_gap_ms: PositiveSchema,
  max_rows: PositiveSchema,
  max_concurrency: PositiveSchema,
  max_series_per_resource: PositiveSchema,
});
/** One setting's provenance, the `Origin` plain type. */
const OriginSchema = z.strictObject({
  layer: z.enum(['package', 'platform', 'group', 'resource']),
  id: IdSchema,
  revision: RevisionSchema.optional(),
});
const SettingSourcesSchema = z.strictObject({
  enabled: OriginSchema,
  interval_ms: OriginSchema,
  timeout_ms: OriginSchema,
  stale_after_ms: OriginSchema,
  max_counter_gap_ms: OriginSchema,
  max_rows: OriginSchema,
  max_concurrency: OriginSchema,
  max_series_per_resource: OriginSchema,
});
const ApplicabilityCheckSchema = z.strictObject({
  attribute: IdSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  supported_values: z.array(z.string()),
  status: z.enum(['supported', 'unsupported', 'unknown']),
});
const MetricSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('collector'), collector_id: IdSchema, raw_field: IdSchema }),
  z.strictObject({ kind: z.literal('derived'), derived_id: IdSchema }),
]);
/**
 * The legacy `Resolved` value of a published single-package row, validated as the
 * `policy/resolver.ts` shape: the real collection plan plus every provenance,
 * dependency and impact field. An empty or spliced object is not a snapshot.
 */
const LegacyResolvedSchema = z.strictObject({
  applicability: z.array(ApplicabilityCheckSchema),
  plan: CollectionPlanSchema,
  metric_templates: z.array(z.strictObject({
    metric: MetricRefSchema,
    source: MetricSourceSchema,
    enabled: z.boolean(),
    required_dimensions: z.array(z.string().min(1)),
    capability: CapabilitySchema,
    decision: z.enum(['collect', 'derive', 'disabled', 'unsupported', 'capability_unknown']),
  })),
  settings: SettingsSchema,
  platform_limits: z.record(z.string(), z.number()),
  sources: SettingSourcesSchema,
  metric_sources: z.record(z.string(), OriginSchema),
  dependencies: z.array(z.strictObject({
    metric: z.string().min(1),
    requires: z.array(z.string().min(1)),
  })),
  collector_timeouts: z.array(z.strictObject({
    collector_id: IdSchema,
    timeout_ms: PositiveSchema,
    source: OriginSchema,
  })),
  impact: z.strictObject({
    requests_per_hour_estimate: z.number().nonnegative(),
    request_unit: z.literal('logical_reads'),
    estimated_series_upper_bound: CountSchema,
    active_collectors: z.array(IdSchema),
    disabled_metrics: z.array(z.string().min(1)),
    unavailable_metrics: z.array(z.string().min(1)),
    estimate: z.literal(true),
  }),
});

// --- the B2C collection plan shape -----------------------------------------
//
// The plan is the stored evidence that a revision was actually resolved. Its
// `kind`/`identity`/`revision`/`resource` labels are checked separately below;
// this schema is what makes a four-label stub insufficient.

const ReleaseRefSchema = z.strictObject({
  id: IdSchema, version: VersionSchema, digest: HashIdSchema,
});
const SettingSourceSchema = z.discriminatedUnion('layer', [
  z.strictObject({ layer: z.literal('platform'), id: IdSchema }),
  z.strictObject({ layer: z.literal('package'), releases: z.array(ReleaseRefSchema) }),
  z.strictObject({ layer: z.literal('group'), id: IdSchema, revision: RevisionSchema }),
  z.strictObject({ layer: z.literal('resource'), id: IdSchema, revision: RevisionSchema }),
]);
const ResolvedParameterSchema = z.strictObject({
  name: ParameterNameSchema,
  type: z.enum(['number', 'integer', 'boolean', 'string']),
  default: ParameterValueSchema.nullable(),
  override: ParameterValueSchema.nullable(),
  effective: ParameterValueSchema,
  source: z.enum(['default', 'override']),
});
const PlanMappingSchema = z.strictObject({
  metric: MetricRefSchema,
  raw_field: IdSchema,
  input_unit: UnitSchema,
  output_unit: UnitSchema,
  transform_version: VersionSchema,
  steps: z.array(z.enum(['decode', 'unit_convert', 'counter_delta', 'rate', 'derive', 'normalize'])).min(2),
});
const PlanItemSchema = z.strictObject({
  pin: TemplatePinSchema,
  template_id: TemplateIdSchema,
  item_id: ItemIdSchema,
  item_version: VersionNumberSchema,
  canonical_metric: MetricRefSchema,
  unit: UnitSchema,
  dimensions: DimensionsSchema,
  mapping: PlanMappingSchema,
  capability: CapabilitySchema,
});
const PlanStepSchema = z.strictObject({
  release: ReleaseRefSchema,
  release_ref: PackageReleaseRefSchema,
  collector_id: IdSchema,
  implementation_id: IdSchema,
  method: z.enum(['sql', 'ssh', 'snmp']),
  estimated_cost: z.enum(['low', 'medium', 'high']),
  timeout_ms: PositiveSchema,
  timeout_source: SettingSourceSchema,
  logical_reads: CountSchema,
  parameter_signature: HashIdSchema,
  metrics: z.array(MetricRefSchema).min(1),
  items: z.array(PlanItemSchema).min(1),
});
const PlanQuerySchema = z.strictObject({
  implementation: IdSchema,
  collectors: z.array(IdSchema).min(1),
  cost: z.enum(['low', 'medium', 'high']),
  logicalReads: CountSchema,
});
const ReleasePlanSchema = z.strictObject({
  release: ReleaseRefSchema,
  release_ref: PackageReleaseRefSchema,
  interval_ms: PositiveSchema,
  timeout_ms: PositiveSchema,
  jitter_ms: CountSchema,
  applicability: z.array(ApplicabilityCheckSchema),
  collector_ids: z.array(IdSchema),
  metric_keys: z.array(z.string().min(1)),
  queries: z.array(PlanQuerySchema),
  requests_per_hour_estimate: z.number().nonnegative(),
  steps: z.array(PlanStepSchema),
});
const ExclusionSchema = z.strictObject({
  pin: TemplatePinSchema,
  template_id: TemplateIdSchema,
  item_id: ItemIdSchema,
  item_version: VersionNumberSchema,
  release: ReleaseRefSchema,
  metric: MetricRefSchema,
  decision: z.enum(['disabled', 'unsupported', 'capability_unknown']),
  reason: z.enum(['settings_disabled', 'metric_disabled', 'capability_unsupported', 'capability_unknown']),
  blocking: z.boolean(),
  capability: CapabilitySchema,
});
const CollectionPlanShapeSchema = z.strictObject({
  kind: z.literal('template_collection_plan'),
  internal: z.literal(true),
  persisted: z.literal(false),
  applied: z.literal(false),
  executable: z.boolean(),
  identity: HashIdSchema,
  resource: z.strictObject({ type: ResourceTypeSchema, id: z.string().regex(/^[1-9]\d{0,15}$/) }),
  revision: RevisionSchema,
  settings: SettingsSchema,
  parameters: z.array(z.strictObject({ pin: TemplatePinSchema, parameters: z.array(ResolvedParameterSchema) })),
  triggers: z.array(z.strictObject({ pin: TemplatePinSchema, refs: z.array(TemplateTriggerRefSchema) })),
  releases: z.array(ReleasePlanSchema),
  excluded: z.array(ExclusionSchema),
  budget: z.strictObject({
    estimate: z.literal(true),
    request_unit: z.literal('logical_reads'),
    estimated_series_upper_bound: CountSchema,
    max_series_per_resource: CountSchema,
    requests_per_hour_estimate: z.number().nonnegative(),
  }),
});

/** The legacy `Applied` value written by `policy/store.ts`; it has no resolution identity. */
const LegacyApplicationSchema = z.strictObject({
  applied_revision: TargetRevisionSchema.nullable(),
  reported_at: TimestampSchema.nullable(),
  status: z.enum(['pending', 'applied', 'failed']),
  error_code: z.literal('apply_failed').nullable(),
});
const LegacyPayloadSchema = z.strictObject({
  binding: z.unknown(),
  /** Checked as the full `Resolved` shape below, so its own failures are reported once. */
  resolved: z.unknown(),
  published_at: TimestampSchema,
  application: LegacyApplicationSchema,
});
/** The template form's application state: the previous applied revision is preserved, never promoted. */
const TemplateApplicationSchema = z.strictObject({
  status: z.enum(['pending', 'applied', 'failed']),
  applied_revision: TargetRevisionSchema.nullable(),
  reported_at: TimestampSchema.nullable(),
  error_code: z.literal('apply_failed').nullable(),
  resolution_identity: HashIdSchema.nullable(),
});
const PendingSchema = z.strictObject({
  base_revision: RevisionSchema,
  target_revision: TargetRevisionSchema,
  resolution_identity: HashIdSchema,
  plan: z.unknown(),
  decided_at: TimestampSchema,
  operation_key: OperationKeySchema,
});

/**
 * The previously effective plan, tagged by where it came from. A package snapshot
 * keeps the legacy `resolved` value untouched; a template snapshot keeps its plan
 * and resolution identity. Neither is ever the current pending plan.
 */
export type EffectiveSnapshot =
  | {
    source: 'package';
    revision: number;
    resolution_identity: null;
    resolved: Record<string, unknown>;
  }
  | {
    source: 'template';
    revision: number;
    resolution_identity: HashId;
    plan: TemplateCollectionPlan;
  };

export interface DecodedLegacyBindingPayload {
  kind: 'legacy_published';
  source: 'package';
  /** The exact stored value (deep copy); re-encoding it reproduces the row unchanged. */
  payload: Record<string, unknown>;
  /** The normalized candidate (`template_pins` defaults to an empty array). */
  binding: ResourceBindingCandidate;
  application: {
    status: 'pending' | 'applied' | 'failed';
    applied_revision: number | null;
    reported_at: string | null;
    error_code: 'apply_failed' | null;
  };
  effective: EffectiveSnapshot | null;
  /** True when `applied_revision` names no revision this row can prove a plan for. */
  effective_missing: boolean;
}

export interface DecodedTemplateBindingPayload {
  kind: 'template_pending';
  source: 'template';
  payload: Record<string, unknown>;
  binding: ResourceBindingCandidate;
  pending: {
    base_revision: number;
    target_revision: number;
    resolution_identity: HashId;
    plan: TemplateCollectionPlan;
    decided_at: string;
    operation_key: string;
  };
  application: {
    status: 'pending' | 'applied' | 'failed';
    applied_revision: number | null;
    reported_at: string | null;
    error_code: 'apply_failed' | null;
    resolution_identity: HashId | null;
  };
  effective: EffectiveSnapshot | null;
  effective_missing: false;
  published_at: string;
}

export type DecodedBindingPayload = DecodedLegacyBindingPayload | DecodedTemplateBindingPayload;
export type BindingPayloadSource = 'package' | 'template';

/**
 * The minimal fence for a legacy reader: it answers which form a payload is and
 * rejects anything ambiguous or malformed. A reader must skip/reject a template
 * payload instead of falling through a single-package path.
 */
export function bindingPayloadSource(raw: string | unknown): BindingPayloadSource {
  return decodeBindingPayload(raw).source;
}

/**
 * True only for values JSON carries without rewriting them. `NaN`/`Infinity`
 * become `null`, `undefined` drops a field and a `BigInt` throws, so an object
 * input with any of them is not a snapshot of any stored row.
 */
function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.every(entry => isJsonValue(entry, seen));
    if (!isPlainObject(value)) return false;
    return Object.values(value).every(entry => isJsonValue(entry, seen));
  } finally {
    seen.delete(value as object);
  }
}

const parseText = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('BINDING_PAYLOAD_INVALID_JSON');
  }
  if (!isPlainObject(parsed)) return fail('BINDING_PAYLOAD_NOT_OBJECT');
  // A number that overflows to `Infinity` parses without error; it is not a value.
  if (!isJsonValue(parsed)) return fail('BINDING_PAYLOAD_SHAPE_INVALID');
  return parsed;
};

const clone = (raw: unknown): Record<string, unknown> => {
  if (!isPlainObject(raw)) return fail('BINDING_PAYLOAD_NOT_OBJECT');
  let copied: unknown;
  try {
    copied = structuredClone(raw);
  } catch {
    // A value that cannot be cloned is not a JSON row.
    return fail('BINDING_PAYLOAD_NOT_OBJECT');
  }
  // structuredClone keeps NaN/Infinity/BigInt/undefined; an object carrying them
  // would be silently rewritten by the encode that follows. Reject it instead.
  if (!isJsonValue(copied)) return fail('BINDING_PAYLOAD_SHAPE_INVALID');
  return copied as Record<string, unknown>;
};

/**
 * Decode one stored payload. `string` input is parsed as JSON; object input is
 * deep-copied first, so neither validation nor a later encode can mutate it.
 */
export function decodeBindingPayload(raw: string | unknown): DecodedBindingPayload {
  const payload = typeof raw === 'string' ? parseText(raw) : clone(raw);

  if (Object.hasOwn(payload, 'envelope')) {
    if (payload.envelope === BINDING_PAYLOAD_ENVELOPE || payload.envelope === BINDING_APPLIED_ENVELOPE) return decodeTemplatePayload(payload);
    // The explicit legacy form: the same `Published` content, no template member.
    if (payload.envelope === BINDING_PAYLOAD_PACKAGE_ENVELOPE) return decodeLegacyPayload(payload, true);
    return fail('BINDING_PAYLOAD_UNKNOWN_ENVELOPE');
  }
  return decodeLegacyPayload(payload, false);
}

/**
 * Decode the single-package form. `enveloped` is true for the explicit
 * `package-v1` carrier, whose only extra member is the envelope itself; the
 * stored value is preserved either way, so a re-encode adds or removes nothing.
 */
function decodeLegacyPayload(
  payload: Record<string, unknown>,
  enveloped: boolean,
): DecodedLegacyBindingPayload {
  if (!isPlainObject(payload.binding)) return fail('BINDING_PAYLOAD_BINDING_INVALID');
  const binding = payload.binding;
  // No envelope or an explicit `package-v1`: only the legacy single-package form
  // is readable. A null package (with or without pins) has no version identity
  // here; package + pins together is ambiguous and never guessed.
  if (binding.package === null || binding.package === undefined) return fail('BINDING_PAYLOAD_MISSING_SOURCE');
  // A pin list that is present but not an array is a malformed row, never an
  // empty selection: only a genuinely absent `template_pins` defaults to [].
  if (Object.hasOwn(binding, 'template_pins') && !Array.isArray(binding.template_pins)) {
    return fail('BINDING_PAYLOAD_BINDING_INVALID');
  }
  const pins = Object.hasOwn(binding, 'template_pins') ? binding.template_pins as unknown[] : [];
  if (pins.length > 0) return fail('BINDING_PAYLOAD_AMBIGUOUS_SOURCE');

  let stored: unknown = payload;
  if (enveloped) {
    const { envelope: _envelope, ...rest } = payload;
    stored = rest;
  }
  const parsed = LegacyPayloadSchema.safeParse(stored);
  if (!parsed.success) return fail('BINDING_PAYLOAD_LEGACY_INVALID');
  const normalized = ResourceBindingCandidateSchema.safeParse({ ...binding, template_pins: pins });
  if (!normalized.success) return fail('BINDING_PAYLOAD_BINDING_INVALID');
  const application = parsed.data.application;
  if (application.status === 'applied' && application.applied_revision === null) {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }
  if (application.error_code !== null && application.status !== 'failed') {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }

  // The stored `resolved` must be the actual resolved view of this binding; an
  // empty, spliced or foreign snapshot is corrupt storage, not evidence.
  const resolved = LegacyResolvedSchema.safeParse(parsed.data.resolved);
  if (!resolved.success) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  checkLegacySnapshot(resolved.data, normalized.data);

  const applied = application.applied_revision;
  // Only a row whose resolved value belongs to the applied revision proves an
  // effective plan. A legacy row that kept the *pending* revision's resolved
  // value cannot prove the older applied one; that fact is reported, never filled.
  const provable = applied !== null && applied === normalized.data.revision;
  return {
    kind: 'legacy_published',
    source: 'package',
    payload,
    binding: normalized.data,
    application: {
      status: application.status,
      applied_revision: application.applied_revision,
      reported_at: application.reported_at,
      error_code: application.error_code,
    },
    effective: provable
      ? {
        source: 'package',
        revision: applied,
        resolution_identity: null,
        resolved: structuredClone(resolved.data) as unknown as Record<string, unknown>,
      }
      : null,
    effective_missing: applied !== null && !provable,
  };
}

const refKeyOf = (resource: { type: string; id: number | string }): string => `${resource.type}:${resource.id}`;

const samePackage = (
  left: { id: string; version: string; digest: string },
  right: { id: string; version: string; digest: string } | null,
): boolean => right !== null
  && left.id === right.id && left.version === right.version && left.digest === right.digest;

/** The plan's policy and the resolved settings are two views of one resolved value. */
const sameResolvedSettings = (
  plan: z.infer<typeof CollectionPlanSchema>,
  settings: z.infer<typeof SettingsSchema>,
): boolean => plan.policy.enabled === settings.enabled
  && plan.policy.interval_ms === settings.interval_ms
  && plan.policy.timeout_ms === settings.timeout_ms
  && plan.policy.stale_after_ms === settings.stale_after_ms
  && plan.policy.max_counter_gap_ms === settings.max_counter_gap_ms
  && plan.policy.max_concurrency === settings.max_concurrency
  && plan.policy.max_series_per_resource === settings.max_series_per_resource;

/**
 * The identity a resolved snapshot must carry to belong to this row: same
 * resource and config revision, the row's own package, and the policy id the
 * accepted resolver derives from the group (or the resource when ungrouped).
 * The plan's policy must also be the same view as the resolved settings.
 */
function checkLegacySnapshot(
  resolved: z.infer<typeof LegacyResolvedSchema>,
  binding: ResourceBindingCandidate,
): void {
  const plan = resolved.plan;
  const collection = plan.binding;
  const key = refKeyOf(binding.resource);
  if (collection.id !== key
    || collection.resource_type !== binding.resource.type
    || collection.resource_id !== String(binding.resource.id)
    || collection.config_revision !== binding.revision
    || !samePackage(collection.package, binding.package)
    || collection.policy_id !== (binding.group_id ?? `resource:${key}`)
    || plan.policy.id !== collection.policy_id
    || !sameResolvedSettings(plan, resolved.settings)) {
    return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  }
}

/**
 * A package snapshot carried by a template row: its resource is the row's own
 * resource and its config revision is the applied revision it claims. Its
 * package is the historical one (the template row has no package pin of its
 * own), so it is compared by source and revision, never against the new pins.
 */
function checkPackageEffectiveSnapshot(
  resolved: z.infer<typeof LegacyResolvedSchema>,
  revision: number,
  resource: { type: string; id: number },
): void {
  const plan = resolved.plan;
  const collection = plan.binding;
  if (collection.id !== refKeyOf(resource)
    || collection.resource_type !== resource.type
    || collection.resource_id !== String(resource.id)
    || collection.config_revision !== revision
    || plan.policy.id !== collection.policy_id
    || !sameResolvedSettings(plan, resolved.settings)) {
    return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  }
}

function decodeTemplatePayload(payload: Record<string, unknown>): DecodedTemplateBindingPayload {
  const formallyApplied = payload.envelope === BINDING_APPLIED_ENVELOPE;
  if (!hasOnlyKeys(payload, ['envelope', 'binding', 'template_resolution', 'application', 'effective', 'published_at',
    ...(formallyApplied ? ['formal_commit'] : [])])) {
    return fail('BINDING_PAYLOAD_SHAPE_INVALID');
  }
  if (!isPlainObject(payload.binding)) return fail('BINDING_PAYLOAD_BINDING_INVALID');
  // The template form never carries a legacy package pin; both sources at once
  // is ambiguous, and no source at all has no version identity. These are read
  // before the candidate schema, whose own refine would collapse them into one
  // generic binding error.
  if (payload.binding.package !== null) {
    return fail(payload.binding.package === undefined
      ? 'BINDING_PAYLOAD_BINDING_INVALID'
      : 'BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
  }
  if (!Array.isArray(payload.binding.template_pins) || payload.binding.template_pins.length === 0) {
    return fail('BINDING_PAYLOAD_MISSING_SOURCE');
  }
  const binding = ResourceBindingCandidateSchema.safeParse(payload.binding);
  if (!binding.success) return fail('BINDING_PAYLOAD_BINDING_INVALID');

  const resolution = payload.template_resolution;
  if (!isPlainObject(resolution) || !hasOnlyKeys(resolution, ['pending'])) {
    return fail('BINDING_PAYLOAD_PENDING_INVALID');
  }
  const pending = PendingSchema.safeParse(resolution.pending);
  if (!pending.success) return fail('BINDING_PAYLOAD_PENDING_INVALID');
  const base = pending.data.base_revision;
  const target = pending.data.target_revision;
  if (!Number.isSafeInteger(base + 1) || base + 1 !== target || binding.data.revision !== target) {
    return fail('BINDING_PAYLOAD_REVISION_INVALID');
  }

  const application = TemplateApplicationSchema.safeParse(payload.application);
  if (!application.success) return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  if (application.data.status === 'applied' && application.data.applied_revision === null) {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }
  if (application.data.error_code !== null && application.data.status !== 'failed') {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }
  if (!formallyApplied && application.data.applied_revision !== null && application.data.applied_revision > base) {
    return fail('BINDING_PAYLOAD_REVISION_INVALID');
  }

  // The plan keeps the identity of the **base** revision's resolution; the target
  // binding revision is mapped explicitly by `pending`, never by rewriting it.
  const pendingPlan = parsePlan(pending.data.plan, {
    identity: pending.data.resolution_identity,
    revision: base,
    resource: binding.data.resource,
  }, 'BINDING_PAYLOAD_PLAN_INVALID');

  const effective = parseEffective(payload.effective, binding.data.resource);
  if (formallyApplied) {
    const proof = FormalCommitSchema.safeParse(payload.formal_commit);
    if (!proof.success || application.data.status !== 'applied'
      || application.data.applied_revision !== target
      || application.data.resolution_identity !== pending.data.resolution_identity
      || application.data.reported_at !== proof.data.at || application.data.error_code !== null) {
      return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
    }
    // Only revision is mapped: no item, release, parameter, switch or identity may change.
    if (effective?.source !== 'template' || effective.revision !== target
      || stable(effective.plan) !== stable({ ...pendingPlan, revision: target })) {
      return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    }
  }
  const applied = application.data.applied_revision;
  if (applied === null) {
    if (effective !== null) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  } else if (effective === null || effective.revision !== applied) {
    return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  }
  if ((effective?.resolution_identity ?? null) !== application.data.resolution_identity) {
    return fail('BINDING_PAYLOAD_IDENTITY_MISMATCH');
  }
  const publishedAt = TimestampSchema.safeParse(payload.published_at);
  if (!publishedAt.success) return fail('BINDING_PAYLOAD_SHAPE_INVALID');

  return {
    kind: 'template_pending',
    source: 'template',
    payload,
    binding: binding.data,
    pending: {
      base_revision: base,
      target_revision: target,
      resolution_identity: pending.data.resolution_identity,
      plan: pendingPlan,
      decided_at: pending.data.decided_at,
      operation_key: pending.data.operation_key,
    },
    application: {
      status: application.data.status,
      applied_revision: application.data.applied_revision,
      reported_at: application.data.reported_at,
      error_code: application.data.error_code,
      resolution_identity: application.data.resolution_identity,
    },
    effective,
    effective_missing: false,
    published_at: publishedAt.data,
  };
}

/**
 * Validate a stored plan as the actual B2C `TemplateCollectionPlan` and as the
 * snapshot of *this* resolution: kind/identity/revision labels alone never prove
 * a plan, so the whole shape is parsed and then the labels and resource are
 * checked against the row.
 */
function parsePlan(
  value: unknown,
  expected: { identity: HashId; revision: number; resource: { type: string; id: number } },
  code: BindingPersistenceErrorCode,
): TemplateCollectionPlan {
  const plan = CollectionPlanShapeSchema.safeParse(value);
  if (!plan.success) return fail(code);
  if (plan.data.identity !== expected.identity
    || plan.data.revision !== expected.revision
    || plan.data.resource.type !== expected.resource.type
    || plan.data.resource.id !== String(expected.resource.id)) {
    return fail(code);
  }
  return value as unknown as TemplateCollectionPlan;
}

function parseEffective(
  value: unknown,
  resource: { type: string; id: number },
): EffectiveSnapshot | null {
  if (value === null) return null;
  if (!isPlainObject(value)) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  if (value.source === 'package') {
    if (!hasOnlyKeys(value, ['source', 'revision', 'resolution_identity', 'resolved'])) {
      return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    }
    const revision = RevisionSchema.safeParse(value.revision);
    if (!revision.success || value.resolution_identity !== null) {
      return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    }
    // The carried package snapshot must be a real resolved view of this resource
    // at the revision it claims, not an empty object or another row's history.
    const resolved = LegacyResolvedSchema.safeParse(value.resolved);
    if (!resolved.success) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    checkPackageEffectiveSnapshot(resolved.data, revision.data, resource);
    return {
      source: 'package', revision: revision.data, resolution_identity: null,
      resolved: structuredClone(resolved.data) as unknown as Record<string, unknown>,
    };
  }
  if (value.source === 'template') {
    if (!hasOnlyKeys(value, ['source', 'revision', 'resolution_identity', 'plan'])) {
      return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    }
    const revision = RevisionSchema.safeParse(value.revision);
    const identity = HashIdSchema.safeParse(value.resolution_identity);
    if (!revision.success || !identity.success) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    const plan = parsePlan(value.plan, {
      identity: identity.data, revision: revision.data, resource,
    }, 'BINDING_PAYLOAD_EFFECTIVE_INVALID');
    return { source: 'template', revision: revision.data, resolution_identity: identity.data, plan };
  }
  return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
}

/** Re-serialize a decoded payload unchanged; a legacy row keeps its exact fields. */
export function encodeBindingPayload(decoded: DecodedBindingPayload): string {
  return JSON.stringify(decoded.payload);
}

/** Called only after the normal formal writer has written these exact identities. */
export function encodeTemplateAppliedPayload(input: DecodedTemplateBindingPayload,
  commit: z.infer<typeof FormalCommitSchema>): string {
  const decoded = decodeBindingPayload(input.payload);
  if (decoded.kind !== 'template_pending') return fail('BINDING_PAYLOAD_BINDING_INVALID');
  const proof = FormalCommitSchema.parse(commit);
  const payload = { ...decoded.payload, envelope: BINDING_APPLIED_ENVELOPE,
    formal_commit: proof,
    application: { status: 'applied', applied_revision: decoded.pending.target_revision,
      reported_at: proof.at, error_code: null, resolution_identity: decoded.pending.resolution_identity },
    effective: { source: 'template', revision: decoded.pending.target_revision,
      resolution_identity: decoded.pending.resolution_identity,
      plan: { ...decoded.pending.plan, revision: decoded.pending.target_revision } } };
  const text = JSON.stringify(payload);
  decodeBindingPayload(text);
  return text;
}

export interface TemplatePendingWriteInput {
  /** The raw candidate with the target revision; never the resolved plan. */
  binding: ResourceBindingCandidate;
  base_revision: number;
  target_revision: number;
  resolution_identity: HashId;
  plan: TemplateCollectionPlan;
  decided_at: string;
  operation_key: string;
  /** Preserved from the previous application; a pending revision never promotes it. */
  applied_revision: number | null;
  previous_resolution_identity: HashId | null;
  previous_effective: EffectiveSnapshot | null;
  published_at: string;
}

/**
 * Build the next pending template payload. The previously effective snapshot and
 * applied revision are copied, never replaced by the pending plan, and the result
 * is validated through the same decoder before it is returned, so a writer cannot
 * persist a row this module would later reject.
 */
export function encodeTemplatePendingPayload(input: TemplatePendingWriteInput): string {
  const previousIdentity = input.previous_effective?.resolution_identity ?? null;
  if (input.previous_resolution_identity !== previousIdentity) {
    return fail('BINDING_PAYLOAD_IDENTITY_MISMATCH');
  }
  if ((input.previous_effective?.revision ?? null) !== input.applied_revision) {
    return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  }
  const payload = {
    envelope: BINDING_PAYLOAD_ENVELOPE,
    binding: structuredClone(input.binding),
    template_resolution: {
      pending: {
        base_revision: input.base_revision,
        target_revision: input.target_revision,
        resolution_identity: input.resolution_identity,
        plan: structuredClone(input.plan),
        decided_at: input.decided_at,
        operation_key: input.operation_key,
      },
    },
    application: {
      status: 'pending',
      applied_revision: input.applied_revision,
      reported_at: null,
      error_code: null,
      resolution_identity: input.previous_resolution_identity,
    },
    effective: input.previous_effective === null ? null : structuredClone(input.previous_effective),
    published_at: input.published_at,
  };
  // `JSON.stringify` rewrites NaN/Infinity to null and drops undefined members, so
  // a writer input carrying them would persist a snapshot it never validated.
  if (!isJsonValue(payload)) return fail('BINDING_PAYLOAD_SHAPE_INVALID');
  const text = JSON.stringify(payload);
  // Self-check: never hand a writer a payload this decoder would reject.
  if (decodeBindingPayload(text).kind !== 'template_pending') {
    return fail('BINDING_PAYLOAD_SHAPE_INVALID');
  }
  return text;
}
