/**
 * MAX-236 P0 D1/D2 source candidate: template composition, immutable versions,
 * drafts and the resource-level multi-template pin candidate.
 *
 * This file is **unmounted and unexported**: it is not imported by
 * `contracts/metrics/index.ts`, `public-api.ts` or any runtime consumer, adds no
 * route, store, second fact source or composition engine, and changes no DDL.
 * It is the executable shape of `docs/slide/development/MAX-236/08-d1-d8-contract-draft.md`
 * §1.1/§1.2/§6 and is reviewed field by field in
 * `docs/slide/development/MAX-236/14-contract-source-candidate.md`.
 *
 * What a successful `parse` proves is **shape only**. Permissions, database
 * immutability, `content_hash` recomputation, revision CAS, uniqueness and
 * transaction/concurrency guarantees are service and integration
 * responsibilities; see §"schema versus service" in `14`.
 *
 * Identity (08 §0.1): `template_id` and `(template_id, item_id)` are stable;
 * `(template_id, version)` is immutable; `revision` is the CAS counter and starts
 * at 0 for a new aggregate, while published version numbers are >= 1.
 */
import { z } from 'zod';
import {
  DimensionsSchema, IdSchema, MetricRefSchema, ResourceTypeSchema, TimestampSchema, UnitSchema, VersionSchema,
} from './definitions.js';

/** `sha256:` + 64 lowercase hex = the 71-character identity used by every D1–D4 hash column. */
export const HashIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Immutable version numbers are 1-based (`metric_template_versions.version INT`). */
export const VersionNumberSchema = z.number().int().positive().max(2147483647);
/** CAS revisions start at the client-supplied initial 0. */
export const RevisionSchema = z.number().int().nonnegative().max(2147483647);
/** New template/rule/item identities; `VARCHAR(64)` in the draft DDL. */
export const TemplateIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const ItemIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const RuleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

/** Ascending, duplicate-free arrays are part of the aggregate's stable serialisation (08 §1.1). */
export const sortedUniqueList = <T>(values: T[], key: (value: T) => string): boolean => {
  const keys = values.map(key);
  return keys.every((value, index) => index === 0 || keys[index - 1] < value);
};
const sortedUnique = sortedUniqueList;

/** Two canonical composition arrays name the same releases for the same items. */
const sameComposition = (left: PackageCompositionEntry[], right: PackageCompositionEntry[]): boolean =>
  left.length === right.length && left.every((entry, index) =>
    entry.release === right[index]?.release
    && entry.items.length === right[index]?.items.length
    && entry.items.every((item, itemIndex) => item === right[index]?.items[itemIndex]));

/** A trigger scope must name an item that actually exists in the same aggregate. */
const checkTriggerScopes = (
  aggregate: { items: { item_id: string }[]; triggers: { scope: string }[] },
  ctx: z.RefinementCtx,
): void => {
  const itemIds = new Set(aggregate.items.map(item => item.item_id));
  for (const [index, trigger] of aggregate.triggers.entries()) {
    if (!itemIds.has(trigger.scope.slice('item:'.length))) {
      ctx.addIssue({ code: 'custom', path: ['triggers', index, 'scope'], message: 'AGGREGATE_SCOPE: trigger scope must reference an aggregate item' });
    }
  }
};

/**
 * A versioned placeholder for a capability that is reserved but not executable.
 * `discovery`/`graphs` keep their contract version and participate in the
 * aggregate hash; `executable` is currently always `false` and `ref: null` means
 * "not wired". A placeholder is never a claim that the capability works.
 */
export const VersionedCapabilityPlaceholderSchema = z.strictObject({
  contract_version: VersionSchema,
  ref: IdSchema.nullable(),
  executable: z.literal(false),
});
export const TemplateCapabilitiesSchema = z.strictObject({
  discovery: VersionedCapabilityPlaceholderSchema,
  graphs: VersionedCapabilityPlaceholderSchema,
});

/**
 * The single `source_chain` definition for every immutable version/snapshot.
 * 08 §1.1 wrote `{base, author_id, ...}` and §7.4 wrote
 * `{actor_id, base_version, migration_ref, ...}`; the field-level resolution is
 * recorded in `14` (section "source_chain 单一精确定义"). Version content is
 * separate from this metadata: retirement may set `retired_at`, but must never
 * rewrite the hash-covered content.
 *
 * `base` is a strict discriminated union so every reference carries the identity
 * its namespace requires: an item only exists inside a template, so
 * `{kind:'item', id, version}` without `template_id` is not a usable base.
 */
export const SourceBaseRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('template'), id: TemplateIdSchema, version: VersionNumberSchema }),
  z.strictObject({ kind: z.literal('trigger'), id: RuleIdSchema, version: VersionNumberSchema }),
  z.strictObject({
    kind: z.literal('item'), template_id: TemplateIdSchema, id: ItemIdSchema, version: VersionNumberSchema,
  }),
]);
export const SourceChainSchema = z.strictObject({
  /** `metric_templates_v2.created_by`/`updated_by` are nullable; migrations may have no actor. */
  actor_id: z.number().int().nonnegative().nullable(),
  request_id: IdSchema,
  base: SourceBaseRefSchema.nullable(),
  created_at: TimestampSchema,
  published_at: TimestampSchema,
  retired_at: TimestampSchema.nullable(),
  migration_ref: IdSchema.nullable(),
}).superRefine((chain, ctx) => {
  if (Date.parse(chain.published_at) < Date.parse(chain.created_at)) {
    ctx.addIssue({ code: 'custom', path: ['published_at'], message: 'SOURCE_CHAIN_ORDER: published_at precedes created_at' });
  }
  if (chain.retired_at !== null && Date.parse(chain.retired_at) < Date.parse(chain.published_at)) {
    ctx.addIssue({ code: 'custom', path: ['retired_at'], message: 'SOURCE_CHAIN_ORDER: retired_at precedes published_at' });
  }
});

export const TemplateBaseRefSchema = z.strictObject({
  template_id: TemplateIdSchema,
  version: VersionNumberSchema,
});
export const TemplateItemRefSchema = z.strictObject({
  item_id: ItemIdSchema,
  version: VersionNumberSchema,
});
/** `scope` is a template-local item reference, not a metric identity (08 §1.1). */
export const TemplateTriggerScopeSchema = z.string().regex(/^item:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const TemplateTriggerRefSchema = z.strictObject({
  rule_id: RuleIdSchema,
  scope: TemplateTriggerScopeSchema,
  version: VersionNumberSchema,
});

export const ParameterNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const ParameterValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export const ParameterSpecSchema = z.strictObject({
  type: z.enum(['number', 'integer', 'boolean', 'string']),
  min: z.number().optional(),
  max: z.number().optional(),
}).superRefine((spec, ctx) => {
  if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
    ctx.addIssue({ code: 'custom', path: ['min'], message: 'PARAMETER_BOUNDS: min exceeds max' });
  }
});
export const TemplateParametersSchema = z.strictObject({
  schema: z.record(ParameterNameSchema, ParameterSpecSchema),
  defaults: z.record(ParameterNameSchema, ParameterValueSchema),
}).superRefine((parameters, ctx) => {
  for (const key of Object.keys(parameters.defaults)) {
    if (!(key in parameters.schema)) {
      ctx.addIssue({ code: 'custom', path: ['defaults', key], message: 'PARAMETER_UNKNOWN_DEFAULT' });
    }
  }
});

/** `${package.id}@${version}#${digest}`: composition names immutable releases only. */
export const PackageReleaseRefSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)#sha256:[a-f0-9]{64}$/);
export const PackageCompositionEntrySchema = z.strictObject({
  release: PackageReleaseRefSchema,
  items: z.array(ItemIdSchema),
}).superRefine((entry, ctx) => {
  if (!sortedUnique(entry.items, item => item)) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'COMPOSITION_ORDER: items must be ascending and unique' });
  }
});

const aggregateFields = {
  template_id: TemplateIdSchema,
  /** Retained as provenance after publication; the resolved items are the authority. */
  base: TemplateBaseRefSchema.nullable(),
  items: z.array(TemplateItemRefSchema),
  triggers: z.array(TemplateTriggerRefSchema),
  parameters: TemplateParametersSchema,
  capabilities: TemplateCapabilitiesSchema,
};

/**
 * Draft input: reference-shaped and unresolved. It carries no
 * `package_composition` because composition is derived at publish/preview time.
 */
export const TemplateDraftAggregateSchema = z.strictObject(aggregateFields).superRefine((aggregate, ctx) => {
  if (!sortedUnique(aggregate.items, item => item.item_id)) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'AGGREGATE_ORDER: items must be ascending and unique by item_id' });
  }
  if (!sortedUnique(aggregate.triggers, trigger => `${trigger.rule_id}\u0000${trigger.scope}`)) {
    ctx.addIssue({ code: 'custom', path: ['triggers'], message: 'AGGREGATE_ORDER: triggers must be ascending and unique by (rule_id, scope)' });
  }
  checkTriggerScopes(aggregate, ctx);
});

/**
 * Published aggregate: the resolved, hash-covered content. Composition is
 * required here because a published template must name the immutable releases it
 * compiles to; it is still only the *shape*, not proof that composition matches
 * the stored package digests.
 *
 * Completeness is content-driven (14 §2.2): when the aggregate has items, every
 * one of them is covered by exactly one composition release and there are no
 * extra or cross-release duplicate item references. Only a metadata aggregate
 * with no items and no triggers may carry an empty composition — that is not
 * evidence of an executable resource.
 */
export const TemplatePublishedAggregateSchema = z.strictObject({
  ...aggregateFields,
  package_composition: z.array(PackageCompositionEntrySchema),
}).superRefine((aggregate, ctx) => {
  if (!sortedUnique(aggregate.items, item => item.item_id)) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'AGGREGATE_ORDER: items must be ascending and unique by item_id' });
  }
  if (!sortedUnique(aggregate.triggers, trigger => `${trigger.rule_id}\u0000${trigger.scope}`)) {
    ctx.addIssue({ code: 'custom', path: ['triggers'], message: 'AGGREGATE_ORDER: triggers must be ascending and unique by (rule_id, scope)' });
  }
  if (!sortedUnique(aggregate.package_composition, entry => entry.release)) {
    ctx.addIssue({ code: 'custom', path: ['package_composition'], message: 'COMPOSITION_ORDER: releases must be ascending and unique' });
  }
  checkTriggerScopes(aggregate, ctx);
  const itemIds = new Set(aggregate.items.map(item => item.item_id));
  const covered = new Set<string>();
  for (const [index, entry] of aggregate.package_composition.entries()) {
    for (const item of entry.items) {
      if (!itemIds.has(item)) {
        ctx.addIssue({ code: 'custom', path: ['package_composition', index, 'items'], message: 'COMPOSITION_UNKNOWN_ITEM' });
      } else if (covered.has(item)) {
        ctx.addIssue({ code: 'custom', path: ['package_composition', index, 'items'], message: 'COMPOSITION_ITEM_DUPLICATE: an item must be covered exactly once' });
      } else {
        covered.add(item);
      }
    }
  }
  for (const itemId of itemIds) {
    if (!covered.has(itemId)) {
      ctx.addIssue({ code: 'custom', path: ['package_composition'], message: 'COMPOSITION_ITEM_UNCOVERED: every published item needs exactly one composition release' });
    }
  }
});

/** An immutable item version; canonical identity is `(template_id, item_id, version)`. */
export const TemplateItemVersionSchema = z.strictObject({
  template_id: TemplateIdSchema,
  item_id: ItemIdSchema,
  version: VersionNumberSchema,
  display_name: z.string().min(1).max(128),
  canonical_metric: MetricRefSchema,
  /** Must equal the canonical metric unit; equality is a service/preview check, not provable here. */
  unit: UnitSchema,
  dimensions: DimensionsSchema,
  collector_ref: z.strictObject({
    package_release: PackageReleaseRefSchema,
    implementation_id: IdSchema,
  }),
  params_default: z.record(ParameterNameSchema, ParameterValueSchema),
  source_chain: SourceChainSchema,
});

export const TemplateVersionStatusSchema = z.enum(['published', 'retired']);
export const TemplateVersionSummarySchema = z.strictObject({
  version: VersionNumberSchema,
  content_hash: HashIdSchema,
  status: TemplateVersionStatusSchema,
});

/**
 * An immutable published version. `content_hash` covers `aggregate` only (08
 * §1.1); `source_chain` is metadata. A retired version keeps its content and hash
 * and only records `retired_at`/status, which is why retirement metadata is
 * excluded from the hash boundary.
 */
export const TemplateVersionSchema = z.strictObject({
  template_id: TemplateIdSchema,
  version: VersionNumberSchema,
  status: TemplateVersionStatusSchema,
  content_hash: HashIdSchema,
  aggregate: TemplatePublishedAggregateSchema,
  items: z.array(TemplateItemVersionSchema),
  package_composition: z.array(PackageCompositionEntrySchema),
  source_chain: SourceChainSchema,
  published_at: TimestampSchema,
  retired_at: TimestampSchema.nullable(),
}).superRefine((version, ctx) => {
  if (version.aggregate.template_id !== version.template_id) {
    ctx.addIssue({ code: 'custom', path: ['aggregate', 'template_id'], message: 'TEMPLATE_VERSION_IDENTITY: aggregate template_id mismatch' });
  }
  for (const [index, item] of version.items.entries()) {
    if (item.template_id !== version.template_id) {
      ctx.addIssue({ code: 'custom', path: ['items', index, 'template_id'], message: 'TEMPLATE_VERSION_IDENTITY: item template_id mismatch' });
    }
  }
  const declared = version.aggregate.items.map(item => `${item.item_id}@${item.version}`).sort().join(',');
  const stored = version.items.map(item => `${item.item_id}@${item.version}`).sort().join(',');
  if (declared !== stored) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'TEMPLATE_ITEM_SNAPSHOT: stored items differ from the aggregate item references' });
  }
  // One payload stays authoritative (14 §2.2): the response copy equals the
  // aggregate copy, and every stored item's collector release is the release
  // that actually composes it. Hashes and releases are not recomputed here.
  if (!sameComposition(version.package_composition, version.aggregate.package_composition)) {
    ctx.addIssue({ code: 'custom', path: ['package_composition'], message: 'TEMPLATE_VERSION_COMPOSITION: version composition must equal the aggregate composition' });
  }
  const releaseByItem = new Map<string, string>();
  for (const entry of version.package_composition) {
    for (const item of entry.items) {
      if (!releaseByItem.has(item)) releaseByItem.set(item, entry.release);
    }
  }
  for (const [index, item] of version.items.entries()) {
    const composedBy = releaseByItem.get(item.item_id);
    if (composedBy === undefined) {
      ctx.addIssue({ code: 'custom', path: ['items', index, 'item_id'], message: 'TEMPLATE_VERSION_COMPOSITION: stored item is not covered by a composition release' });
    } else if (item.collector_ref.package_release !== composedBy) {
      ctx.addIssue({ code: 'custom', path: ['items', index, 'collector_ref', 'package_release'], message: 'TEMPLATE_VERSION_COMPOSITION: collector release differs from the covering composition release' });
    }
  }
  // The response timestamps and the lineage copy describe the same instants;
  // item lineage is deliberately not compared to the parent template's times.
  if (Date.parse(version.published_at) !== Date.parse(version.source_chain.published_at)) {
    ctx.addIssue({ code: 'custom', path: ['published_at'], message: 'TEMPLATE_VERSION_LINEAGE: published_at differs from source_chain.published_at' });
  }
  const chainRetired = version.source_chain.retired_at;
  if (version.retired_at === null
    ? chainRetired !== null
    : chainRetired === null || Date.parse(chainRetired) !== Date.parse(version.retired_at)) {
    ctx.addIssue({ code: 'custom', path: ['retired_at'], message: 'TEMPLATE_VERSION_LINEAGE: retired_at differs from source_chain.retired_at' });
  }
  if ((version.status === 'retired') !== (version.retired_at !== null)) {
    ctx.addIssue({ code: 'custom', path: ['retired_at'], message: 'TEMPLATE_VERSION_STATUS: retired status and retired_at must agree' });
  }
  if (version.retired_at !== null && Date.parse(version.retired_at) < Date.parse(version.published_at)) {
    ctx.addIssue({ code: 'custom', path: ['retired_at'], message: 'TEMPLATE_VERSION_STATUS: retired_at precedes published_at' });
  }
});

export const TemplateStatusSchema = z.enum(['draft', 'active', 'deprecated', 'archived']);
export const TemplateRecordSchema = z.strictObject({
  template_id: TemplateIdSchema,
  name: z.string().min(1).max(128),
  status: TemplateStatusSchema,
  /** Pointer to the current version; rollback changes only this pointer. */
  current_published_version: VersionNumberSchema.nullable(),
  revision: RevisionSchema,
  created_by: z.number().int().nonnegative().nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).superRefine((template, ctx) => {
  if (Date.parse(template.updated_at) < Date.parse(template.created_at)) {
    ctx.addIssue({ code: 'custom', path: ['updated_at'], message: 'TEMPLATE_TIME_ORDER: updated_at precedes created_at' });
  }
});

/** The only editable surface; a draft is not a version and never participates in the content hash. */
export const TemplateDraftSchema = z.strictObject({
  template_id: TemplateIdSchema,
  revision: RevisionSchema,
  aggregate: TemplateDraftAggregateSchema,
  published_version: VersionNumberSchema.nullable(),
  updated_by: z.number().int().nonnegative().nullable(),
  updated_at: TimestampSchema,
}).superRefine((draft, ctx) => {
  if (draft.aggregate.template_id !== draft.template_id) {
    ctx.addIssue({ code: 'custom', path: ['aggregate', 'template_id'], message: 'TEMPLATE_DRAFT_IDENTITY: aggregate template_id mismatch' });
  }
});

export const CreateTemplateRequestSchema = z.strictObject({
  name: z.string().min(1).max(128),
});
/** `template_id` is server-issued; the new aggregate's revision is exactly 0. */
export const CreateTemplateResponseSchema = z.strictObject({
  template_id: TemplateIdSchema,
  revision: z.literal(0),
});

export const UpdateTemplateDraftRequestSchema = z.strictObject({
  expected_draft_revision: RevisionSchema,
  aggregate: TemplateDraftAggregateSchema,
});
export const UpdateTemplateDraftResponseSchema = z.strictObject({
  revision: RevisionSchema,
});
export const TemplateDraftResponseSchema = z.strictObject({
  revision: RevisionSchema,
  aggregate: TemplateDraftAggregateSchema,
  published_version: VersionNumberSchema.nullable(),
});

export const PreviewTemplateRequestSchema = z.strictObject({
  expected_draft_revision: RevisionSchema,
});
export const TemplateConflictCodeSchema = z.enum([
  'TEMPLATE_CANONICAL_CONFLICT', 'TEMPLATE_UNIT_MISMATCH', 'TEMPLATE_PIN_NOT_FOUND',
]);
export const TemplateConflictSchema = z.strictObject({
  code: TemplateConflictCodeSchema,
  metric: MetricRefSchema.optional(),
  template_item_id: ItemIdSchema.optional(),
  message: z.string().min(1),
});
export const PreviewTemplateResponseSchema = z.strictObject({
  content_hash: HashIdSchema,
  conflicts: z.array(TemplateConflictSchema),
  affected_metrics: z.array(MetricRefSchema),
  composition: z.array(PackageCompositionEntrySchema),
  estimate: z.literal(true),
});

export const PublishTemplateRequestSchema = z.strictObject({
  expected_draft_revision: RevisionSchema,
  expected_revision: RevisionSchema,
});
/**
 * A successful publish is either an idempotent no-op (an identical content hash
 * already exists; the current pointer is untouched) or a new immutable version.
 * The HTTP status (200 vs 201) is a transport detail; `noop` is the contract.
 */
export const PublishTemplateResponseSchema = z.discriminatedUnion('noop', [
  z.strictObject({ version: VersionNumberSchema, content_hash: HashIdSchema, noop: z.literal(false) }),
  z.strictObject({ version: VersionNumberSchema, content_hash: HashIdSchema, noop: z.literal(true) }),
]);

export const SwitchTemplateCurrentRequestSchema = z.strictObject({
  version: VersionNumberSchema,
  expected_revision: RevisionSchema,
  reason: z.string().min(1).max(256),
});
export const SwitchTemplateCurrentResponseSchema = z.strictObject({
  current_published_version: VersionNumberSchema,
  revision: RevisionSchema,
});

export const RetireTemplateVersionRequestSchema = z.strictObject({
  version: VersionNumberSchema,
  expected_revision: RevisionSchema,
  reason: z.string().min(1).max(256),
});
export const RetireTemplateVersionResponseSchema = z.strictObject({
  version: VersionNumberSchema,
  status: z.literal('retired'),
});

export const TemplateListQuerySchema = z.strictObject({
  status: TemplateStatusSchema.optional(),
  cursor: IdSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export const TemplateListResponseSchema = z.strictObject({
  items: z.array(z.strictObject({
    template_id: TemplateIdSchema,
    name: z.string().min(1).max(128),
    status: TemplateStatusSchema,
    current_published_version: VersionNumberSchema.nullable(),
    revision: RevisionSchema,
  })),
  next_cursor: IdSchema.nullable(),
});
export const TemplateDetailResponseSchema = z.strictObject({
  template: TemplateRecordSchema,
  current: TemplateVersionSchema.nullable(),
  versions: z.array(TemplateVersionSummarySchema),
  items: z.array(TemplateItemVersionSchema),
});

/** The existing single-package pin; kept for lossless fallback (F-B). */
export const PackagePinSchema = z.strictObject({
  id: IdSchema,
  version: VersionSchema,
  digest: HashIdSchema,
});
/** One fixed template pin: an exact immutable version, never the `current` pointer. */
export const TemplatePinSchema = z.strictObject({
  template_id: TemplateIdSchema,
  version: VersionNumberSchema,
  content_hash: HashIdSchema,
});
export const TemplatePinsSchema = z.array(TemplatePinSchema).refine(
  pins => sortedUnique(pins, pin => pin.template_id),
  { message: 'TEMPLATE_PINS_ORDER: pins must be ascending and unique by template_id' },
);
export const ResourceRefSchema = z.strictObject({
  type: ResourceTypeSchema,
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * The candidate delta on the existing per-resource `payload.binding`:
 * `template_pins` is added, `revision` stays the only CAS authority, and the
 * legacy single-package pin remains valid when no multi-pin set is present.
 * `overrides`/`group_id` are carried unchanged; this file does not redefine the
 * existing policy model or resolve configuration.
 */
export const ResourceBindingCandidateSchema = z.strictObject({
  resource: ResourceRefSchema,
  package: PackagePinSchema.nullable(),
  group_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
  overrides: z.record(z.string(), z.unknown()),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  template_pins: TemplatePinsSchema,
}).superRefine((binding, ctx) => {
  if (binding.template_pins.length === 0 && binding.package === null) {
    ctx.addIssue({ code: 'custom', path: ['template_pins'], message: 'BINDING_PIN_REQUIRED: multi-pin set and legacy package are both empty' });
  }
});

export const BindingApplicationSchema = z.strictObject({
  applied_revision: z.number().int().positive().nullable(),
  reported_at: TimestampSchema.nullable(),
  status: z.enum(['pending', 'applied', 'failed']),
  error_code: z.literal('apply_failed').nullable(),
});
/** The runtime envelope is `Published` ({binding, resolved, published_at, application}); `resolved` stays opaque. */
export const PublishedResourceBindingSchema = z.strictObject({
  binding: ResourceBindingCandidateSchema,
  resolved: z.record(z.string(), z.unknown()),
  published_at: TimestampSchema,
  application: BindingApplicationSchema,
});

export const ResourceTemplatePinsResponseSchema = z.strictObject({
  template_pins: TemplatePinsSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  resolved_hash: HashIdSchema.nullable(),
  effective_triggers: z.array(HashIdSchema).refine(
    values => sortedUnique(values, value => value),
    { message: 'EFFECTIVE_TRIGGER_ORDER: ids must be ascending and unique' },
  ),
});
export const PreviewResourceTemplatesRequestSchema = z.strictObject({
  template_pins: TemplatePinsSchema,
});
export const PublishResourceTemplatesRequestSchema = z.strictObject({
  expected_revision: RevisionSchema,
  template_pins: TemplatePinsSchema,
});
export const PublishResourceTemplatesResponseSchema = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  applied: z.literal('pending'),
});

export type HashId = z.infer<typeof HashIdSchema>;
export type VersionNumber = z.infer<typeof VersionNumberSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type SourceBaseRef = z.infer<typeof SourceBaseRefSchema>;
export type SourceChain = z.infer<typeof SourceChainSchema>;
export type TemplateCapabilities = z.infer<typeof TemplateCapabilitiesSchema>;
export type TemplateParameters = z.infer<typeof TemplateParametersSchema>;
export type PackageCompositionEntry = z.infer<typeof PackageCompositionEntrySchema>;
export type TemplateDraftAggregate = z.infer<typeof TemplateDraftAggregateSchema>;
export type TemplatePublishedAggregate = z.infer<typeof TemplatePublishedAggregateSchema>;
export type TemplateItemVersion = z.infer<typeof TemplateItemVersionSchema>;
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;
export type TemplateRecord = z.infer<typeof TemplateRecordSchema>;
export type TemplateDraft = z.infer<typeof TemplateDraftSchema>;
export type PreviewTemplateResponse = z.infer<typeof PreviewTemplateResponseSchema>;
export type PublishTemplateResponse = z.infer<typeof PublishTemplateResponseSchema>;
export type TemplatePin = z.infer<typeof TemplatePinSchema>;
export type PackagePin = z.infer<typeof PackagePinSchema>;
export type ResourceBindingCandidate = z.infer<typeof ResourceBindingCandidateSchema>;
export type PublishedResourceBinding = z.infer<typeof PublishedResourceBindingSchema>;
