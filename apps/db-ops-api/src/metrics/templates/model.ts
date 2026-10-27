/**
 * MAX-237 / T1 — internal template domain model (the D1 template subset).
 *
 * Field-level provenance: `docs/slide/development/MAX-236/08-d1-d8-contract-draft.md`
 * §0.1/§1.1, the nine field decisions plus C14-1…C14-3 revisions in
 * `docs/slide/development/MAX-236/14-contract-source-candidate.md` §8/§10, and the
 * still-unfrozen source candidate `apps/db-ops-api/src/contracts/metrics/templates.ts`
 * at MAX-236 HEAD. D1 as a whole is **not** frozen; this file implements only the
 * subset the MAX-237-T1 package was admitted for: stable template/item identity,
 * immutable version numbers, canonical metric reference, collector pin and the
 * explicit mapping that ties them together.
 *
 * Not implemented here on purpose (see `docs/slide/development/MAX-237/`):
 * resource bindings and multi-pin resolution, triggers/rule versions, preview
 * estimates, retirement of published versions, and every database/DDL shape.
 * Those belong to MAX-238/239 and to a later persistence package.
 *
 * `parse` proves shape only. Permission, atomicity, immutability across rows and
 * hash recomputation are repository/service responsibilities.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DimensionsSchema, IdSchema, MetricRefSchema, TimestampSchema, UnitSchema, VersionSchema,
} from '../../contracts/metrics/index.js';
import { stable } from '../packages/model.js';

/** New template/item identities; mirrors the candidate's `VARCHAR(64)` key domain. */
export const TemplateIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const ItemIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
/** Rule identity is only ever a reference here; rule versions are MAX-239. */
export const TriggerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
/** `sha256:` + 64 lowercase hex — the 71-character identity of every hash column. */
export const HashIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Immutable version numbers are 1-based; revision CAS counters start at 0. */
export const VersionNumberSchema = z.number().int().positive().max(2147483647);
export const RevisionSchema = z.number().int().nonnegative().max(2147483647);

export function sortedUnique<T>(values: T[], key: (value: T) => string): boolean {
  const keys = values.map(key);
  return keys.every((value, index) => index === 0 || keys[index - 1] < value);
}

/** Ascending, duplicate-free arrays are part of the aggregate's canonical serialisation. */
const itemsSorted = (items: TemplateItemRef[]) => sortedUnique(items, item => item.item_id);
const triggersSorted = (triggers: TemplateTriggerRef[]) =>
  sortedUnique(triggers, trigger => `${trigger.rule_id}\u0000${trigger.scope}`);

/**
 * A versioned placeholder for a capability that is reserved but not executable.
 * `executable` is always `false` and `ref: null` means "not wired"; a placeholder
 * is never a claim that discovery or graphs work.
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

/**
 * `${package.id}@${version}#${digest}`: composition names immutable releases only.
 * The digest is what makes the collector pin and the registry release the same thing.
 */
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

export const TemplateItemRefSchema = z.strictObject({
  item_id: ItemIdSchema,
  version: VersionNumberSchema,
});
export const TemplateBaseRefSchema = z.strictObject({
  template_id: TemplateIdSchema,
  version: VersionNumberSchema,
});
/** `scope` is a template-local item reference, never a metric identity. */
export const TemplateTriggerScopeSchema = z.string().regex(/^item:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const TemplateTriggerRefSchema = z.strictObject({
  rule_id: TriggerIdSchema,
  scope: TemplateTriggerScopeSchema,
  version: VersionNumberSchema,
});

/** Item-only templates are the admitted case; a trigger scope must name an aggregate item. */
function checkTriggerScopes(
  aggregate: { items: Array<{ item_id: string }>; triggers: Array<{ scope: string }> },
  ctx: z.RefinementCtx,
) {
  const itemIds = new Set(aggregate.items.map(item => item.item_id));
  for (const [index, trigger] of aggregate.triggers.entries()) {
    if (!itemIds.has(trigger.scope.slice('item:'.length))) {
      ctx.addIssue({ code: 'custom', path: ['triggers', index, 'scope'], message: 'AGGREGATE_SCOPE: trigger scope must reference an aggregate item' });
    }
  }
}

const aggregateFields = {
  template_id: TemplateIdSchema,
  /** Provenance only. Publish refuses a non-null base; inheritance resolution is not frozen. */
  base: TemplateBaseRefSchema.nullable(),
  items: z.array(TemplateItemRefSchema),
  triggers: z.array(TemplateTriggerRefSchema),
  parameters: TemplateParametersSchema,
  capabilities: TemplateCapabilitiesSchema,
};

/** Draft input: reference-shaped and unresolved; composition is derived at publish time. */
export const TemplateDraftAggregateSchema = z.strictObject(aggregateFields).superRefine((aggregate, ctx) => {
  if (!itemsSorted(aggregate.items)) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'AGGREGATE_ORDER: items must be ascending and unique by item_id' });
  }
  if (!triggersSorted(aggregate.triggers)) {
    ctx.addIssue({ code: 'custom', path: ['triggers'], message: 'AGGREGATE_ORDER: triggers must be ascending and unique by (rule_id, scope)' });
  }
  checkTriggerScopes(aggregate, ctx);
});

/**
 * Published aggregate: the resolved, hash-covered content. Composition is required
 * here because a published template must name the immutable releases it compiles
 * to — but this is still only the *shape*, not proof that the composition matches
 * the stored package digests.
 */
export const TemplatePublishedAggregateSchema = z.strictObject({
  ...aggregateFields,
  package_composition: z.array(PackageCompositionEntrySchema),
}).superRefine((aggregate, ctx) => {
  if (!itemsSorted(aggregate.items)) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'AGGREGATE_ORDER: items must be ascending and unique by item_id' });
  }
  if (!triggersSorted(aggregate.triggers)) {
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

/**
 * The single `source_chain` definition (14 §2.3). Version content is separate from
 * this metadata: retirement may set `retired_at` and never rewrites content.
 */
const SourceBaseRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('template'), id: TemplateIdSchema, version: VersionNumberSchema }),
  z.strictObject({ kind: z.literal('trigger'), id: TriggerIdSchema, version: VersionNumberSchema }),
  z.strictObject({
    kind: z.literal('item'), template_id: TemplateIdSchema, id: ItemIdSchema, version: VersionNumberSchema,
  }),
]);
export const SourceChainSchema = z.strictObject({
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

/**
 * An immutable item version; canonical identity is `(template_id, item_id, version)`.
 * The explicit mapping is `canonical_metric` + `collector_ref` + `unit`/`dimensions`:
 * the raw field and transform steps are resolved from the digest-pinned release
 * instead of being copied here, so they cannot drift from the release they name.
 */
export const TemplateItemVersionSchema = z.strictObject({
  template_id: TemplateIdSchema,
  item_id: ItemIdSchema,
  version: VersionNumberSchema,
  display_name: z.string().trim().min(1).max(128),
  canonical_metric: MetricRefSchema,
  /** Must equal the canonical definition unit; enforced by the service at selection/publish. */
  unit: UnitSchema,
  /** Dimension name → meaning, auto-filled from the canonical definition. */
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
 * An immutable published version. `content_hash` covers `aggregate` only; the
 * response copies below must agree with the aggregate they snapshot, and the
 * stored items must be exactly the items the aggregate names.
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
  const composition = stable(version.package_composition);
  if (composition !== stable(version.aggregate.package_composition)) {
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
});

export const TemplateStatusSchema = z.enum(['draft', 'active', 'deprecated', 'archived']);
export const TemplateRecordSchema = z.strictObject({
  template_id: TemplateIdSchema,
  name: z.string().trim().min(1).max(128),
  status: TemplateStatusSchema,
  /** Pointer to the current version; switching it back never rewrites a version. */
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

/** The only editable surface; a draft is not a version and never enters the content hash. */
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

/** One fixed template pin: an exact immutable version, never the `current` pointer. */
export const TemplatePinSchema = z.strictObject({
  template_id: TemplateIdSchema,
  version: VersionNumberSchema,
  content_hash: HashIdSchema,
});

export type HashId = z.infer<typeof HashIdSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type VersionNumber = z.infer<typeof VersionNumberSchema>;
export type SourceChain = z.infer<typeof SourceChainSchema>;
export type TemplateCapabilities = z.infer<typeof TemplateCapabilitiesSchema>;
export type TemplateParameters = z.infer<typeof TemplateParametersSchema>;
export type ParameterValue = z.infer<typeof ParameterValueSchema>;
export type TemplateItemRef = z.infer<typeof TemplateItemRefSchema>;
export type TemplateTriggerRef = z.infer<typeof TemplateTriggerRefSchema>;
export type TemplateDraftAggregate = z.infer<typeof TemplateDraftAggregateSchema>;
export type TemplatePublishedAggregate = z.infer<typeof TemplatePublishedAggregateSchema>;
export type PackageCompositionEntry = z.infer<typeof PackageCompositionEntrySchema>;
export type TemplateItemVersion = z.infer<typeof TemplateItemVersionSchema>;
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;
export type TemplateVersionStatus = z.infer<typeof TemplateVersionStatusSchema>;
export type TemplateVersionSummary = z.infer<typeof TemplateVersionSummarySchema>;
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;
export type TemplateRecord = z.infer<typeof TemplateRecordSchema>;
export type TemplateDraft = z.infer<typeof TemplateDraftSchema>;
export type TemplatePin = z.infer<typeof TemplatePinSchema>;
export type PackageReleaseRef = { id: string; version: string; digest: HashId };
export type MetricRef = z.infer<typeof MetricRefSchema>;

export const canonicalKey = (ref: MetricRef): string => `${ref.id}@${ref.semantic_version}`;

export const packageReleaseRef = (pin: { id: string; version: string; digest: string }): string =>
  `${pin.id}@${pin.version}#${pin.digest}`;

/** Inverse of {@link packageReleaseRef}; shape was already validated by the schema. */
export function parsePackageReleaseRef(ref: string): PackageReleaseRef {
  const at = ref.lastIndexOf('@');
  const hash = ref.lastIndexOf('#');
  return { id: ref.slice(0, at), version: ref.slice(at + 1, hash), digest: ref.slice(hash + 1) };
}

export const placeholderCapabilities = (): TemplateCapabilities => ({
  discovery: { contract_version: '1.0.0', ref: null, executable: false },
  graphs: { contract_version: '1.0.0', ref: null, executable: false },
});

export function emptyDraftAggregate(templateId: string): TemplateDraftAggregate {
  return {
    template_id: templateId,
    base: null,
    items: [],
    triggers: [],
    parameters: { schema: {}, defaults: {} },
    capabilities: placeholderCapabilities(),
  };
}

/** `content_hash = "sha256:" + sha256(stable(aggregate))` — the hash boundary is the whole aggregate. */
export function templateContentHash(aggregate: TemplatePublishedAggregate): HashId {
  return `sha256:${createHash('sha256').update(stable(aggregate)).digest('hex')}`;
}
