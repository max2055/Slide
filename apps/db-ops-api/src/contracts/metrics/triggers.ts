/**
 * MAX-239 — minimal internal trigger contract: fixed rule versions, the
 * restricted comparison AST, the resolved rule candidate and the immutable
 * resource rule snapshot.
 *
 * Published rules and event evidence are exposed through the metrics public API.
 * The runtime adapter mounts these contracts on the existing formal writer and
 * alert/event path; application evidence remains separately fenced.
 *
 * Why a separate body at all: the fixed template version only names
 * `(rule_id, version, scope)`. A trigger cannot be evaluated from that reference,
 * and a display/metric name must never be used to guess the rule. A rule version
 * here is the exact, content-hashed body a trusted catalog must return for that
 * identity.
 *
 * What a successful parse proves is **shape plus the declared bounds only**.
 * Content-hash recomputation, catalog identity, item/metric/unit agreement,
 * parameter resolution and application fencing are the resolver/compiler/
 * evaluator responsibilities in `metrics/triggers/`.
 *
 * The AST is deliberately not a DSL and not Zabbix syntax: no function calls, no
 * `eval`, no `new Function`, no SQL/script text, no macros. `last`/`avg`/`min`/
 * `max`, comparisons, AND/OR, resolved numeric parameters, explicit nodata and
 * bounded windows/depth/nodes only.
 */
import { z } from 'zod';
import { MetricRefSchema, ResourceTypeSchema, TimestampSchema, UnitSchema } from './definitions.js';
import { ScalarValueSchema, QualitySchema, AccuracySchema } from './observations.js';
import {
  HashIdSchema, ItemIdSchema, ParameterNameSchema, ParameterValueSchema, RevisionSchema,
  RuleIdSchema, TemplateIdSchema, TemplateParametersSchema, TemplateTriggerScopeSchema,
  VersionNumberSchema,
} from './templates.js';

/** The contract version of this internal shape, independent of the public API contract. */
export const TRIGGER_CONTRACT_VERSION = '1.0.0';

/**
 * Hard bounds. They are constants, not rule fields: a rule author cannot raise
 * them, and the resolver rejects an expression or a snapshot that exceeds them
 * with a stable code instead of truncating it.
 */
export const TRIGGER_LIMITS = Object.freeze({
  /** Maximum nesting of AND/OR groups (a leaf is depth 1). */
  max_depth: 5,
  /** Maximum nodes in one problem or recovery expression. */
  max_nodes: 32,
  /** Maximum aggregation window: one day. `last` has no window. */
  max_window_ms: 86_400_000,
  /** Maximum distinct dimension series one rule evaluates per call. */
  max_series: 32,
  /** Maximum declared parameters of one rule version. */
  max_parameters: 16,
  /** Maximum rules carried by one resource snapshot. */
  max_rules: 64,
});

export const TriggerOperatorSchema = z.enum(['>', '>=', '<', '<=', '=', '!=']);
export const TriggerAggregationSchema = z.enum(['last', 'avg', 'min', 'max']);

/**
 * A leaf selector. `last` reads the newest acceptable sample; the windowed
 * aggregations read the samples of the last `window_ms` and require contiguous
 * sample windows. No free window expression exists.
 */
export const TriggerSelectorSchema = z.discriminatedUnion('aggregation', [
  z.strictObject({ aggregation: z.literal('last') }),
  z.strictObject({
    aggregation: z.enum(['avg', 'min', 'max']),
    window_ms: z.number().int().positive().max(TRIGGER_LIMITS.max_window_ms),
  }),
]);
export type TriggerSelector = z.infer<typeof TriggerSelectorSchema>;

/** A threshold is either fixed in the rule or a typed rule parameter resolved at compile time. */
export const TriggerThresholdSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('constant'), value: z.number().finite() }),
  z.strictObject({ kind: z.literal('parameter'), name: ParameterNameSchema }),
]);
export type TriggerThreshold = z.infer<typeof TriggerThresholdSchema>;

const compareNode = {
  node: z.literal('compare'),
  select: TriggerSelectorSchema,
  operator: TriggerOperatorSchema,
  threshold: TriggerThresholdSchema,
};
const groupNode = {
  node: z.enum(['all', 'any']),
  children: z.array(z.lazy(() => TriggerExpressionSchema)).min(2).max(TRIGGER_LIMITS.max_nodes),
};

/**
 * The restricted expression. `all` is AND, `any` is OR; a group needs at least
 * two children, so there is no single-child wrapper and no implicit `not`
 * (recovery is written as its own expression, never as the negation of problem).
 */
export type TriggerExpression =
  | { node: 'compare'; select: TriggerSelector; operator: z.infer<typeof TriggerOperatorSchema>; threshold: TriggerThreshold }
  | { node: 'all' | 'any'; children: TriggerExpression[] };
export const TriggerExpressionSchema: z.ZodType<TriggerExpression> = z.lazy(() =>
  z.union([z.strictObject(compareNode), z.strictObject(groupNode)]),
) as z.ZodType<TriggerExpression>;

/** A resolved threshold is always a concrete finite number; no parameter survives compilation. */
export const ResolvedTriggerThresholdSchema = z.strictObject({
  kind: z.literal('constant'),
  value: z.number().finite(),
});
export type ResolvedTriggerThreshold = z.infer<typeof ResolvedTriggerThresholdSchema>;

export type ResolvedTriggerExpression =
  | { node: 'compare'; select: TriggerSelector; operator: z.infer<typeof TriggerOperatorSchema>; threshold: ResolvedTriggerThreshold }
  | { node: 'all' | 'any'; children: ResolvedTriggerExpression[] };
export const ResolvedTriggerExpressionSchema: z.ZodType<ResolvedTriggerExpression> = z.lazy(() =>
  z.union([
    z.strictObject({ ...compareNode, threshold: ResolvedTriggerThresholdSchema }),
    z.strictObject({
      node: z.enum(['all', 'any']),
      children: z.array(z.lazy(() => ResolvedTriggerExpressionSchema)).min(2).max(TRIGGER_LIMITS.max_nodes),
    }),
  ]),
) as z.ZodType<ResolvedTriggerExpression>;

/**
 * Evidence gates shared by problem and recovery. A sample that fails any of them
 * makes the evaluation unknown; it never counts as a recovery.
 */
export const TriggerQualityPolicySchema = z.strictObject({
  accepted_quality: z.array(z.enum(['good', 'partial'])).min(1),
  min_coverage: z.number().min(0).max(1),
  allow_estimated: z.boolean(),
});
export type TriggerQualityPolicy = z.infer<typeof TriggerQualityPolicySchema>;

/**
 * Clock policy, evaluated against `now` alone (no new sample needed):
 * `stale_after_ms` bounds how old the newest sample may be, and the explicit
 * `nodata` block is the independent missing-data trigger.
 */
export const TriggerClockPolicySchema = z.strictObject({
  stale_after_ms: z.number().int().positive(),
  nodata: z.union([
    z.strictObject({ enabled: z.literal(true), after_ms: z.number().int().positive() }),
    z.strictObject({ enabled: z.literal(false) }),
  ]),
});
export type TriggerClockPolicy = z.infer<typeof TriggerClockPolicySchema>;

/**
 * One immutable rule version as a trusted catalog must return it for an exact
 * `(rule_id, version)`. `content_hash` covers every other member and is
 * recomputed by the resolver; a catalog that returns another body for the same
 * identity is rejected, never first-wins.
 */
export const TriggerRuleVersionSchema = z.strictObject({
  rule_id: RuleIdSchema,
  version: VersionNumberSchema,
  /** Template-local item reference, exactly the accepted `TemplateTriggerScopeSchema`. */
  scope: TemplateTriggerScopeSchema,
  metric: MetricRefSchema,
  unit: UnitSchema,
  /** Declaration and defaults of the thresholds/parameters this body may reference. */
  parameters: TemplateParametersSchema,
  problem: TriggerExpressionSchema,
  recovery: TriggerExpressionSchema,
  quality: TriggerQualityPolicySchema,
  clock: TriggerClockPolicySchema,
  content_hash: HashIdSchema,
}).superRefine((rule, ctx) => {
  if (Object.keys(rule.parameters.schema).length > TRIGGER_LIMITS.max_parameters) {
    ctx.addIssue({ code: 'custom', path: ['parameters', 'schema'], message: 'TRIGGER_RULE_PARAMETER_BUDGET' });
  }
});
export type TriggerRuleVersion = z.infer<typeof TriggerRuleVersionSchema>;

/** Resource UI publishes a new immutable template version; identities are server-derived. */
export const TemplateTriggerPublishSchema = z.strictObject({
  expected_version: VersionNumberSchema,
  expected_content_hash: HashIdSchema,
  item_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  parameters: TemplateParametersSchema,
  problem: TriggerExpressionSchema,
  recovery: TriggerExpressionSchema,
  quality: TriggerQualityPolicySchema,
  clock: TriggerClockPolicySchema,
});

/** One parameter after resolution; `source` says which input decided it. */
export const ResolvedTriggerParameterSchema = z.strictObject({
  name: ParameterNameSchema,
  type: z.enum(['number', 'integer', 'boolean', 'string']),
  value: ParameterValueSchema,
  source: z.enum(['default', 'override']),
});
export type ResolvedTriggerParameter = z.infer<typeof ResolvedTriggerParameterSchema>;

/** The stable item identity a rule is bound to; `version` is the template item version. */
export const TriggerItemIdentitySchema = z.strictObject({
  template_id: TemplateIdSchema,
  item_id: ItemIdSchema,
  item_version: VersionNumberSchema,
});
export type TriggerItemIdentity = z.infer<typeof TriggerItemIdentitySchema>;

const candidateRuleFields = {
  rule_id: RuleIdSchema,
  version: VersionNumberSchema,
  /** The verified catalog content hash of this exact version. */
  body_hash: HashIdSchema,
  scope: TemplateTriggerScopeSchema,
  item: TriggerItemIdentitySchema,
  metric: MetricRefSchema,
  unit: UnitSchema,
  dimensions: z.record(z.string(), z.string().min(1)),
  /** The B2C selection decision for the item, carried — never re-derived from a name. */
  decision: z.enum(['collect', 'derive', 'disabled', 'unsupported', 'capability_unknown']),
  parameters: z.array(ResolvedTriggerParameterSchema),
  problem: ResolvedTriggerExpressionSchema,
  recovery: ResolvedTriggerExpressionSchema,
  quality: TriggerQualityPolicySchema,
  clock: TriggerClockPolicySchema,
};

/**
 * A resolved rule **candidate**: fully resolved semantics, no application claim
 * and no aggregate hash yet. It is what a later compile step turns into a
 * snapshot; it is never evidence that a rule is in effect.
 */
export const TriggerRuleCandidateSchema = z.strictObject(candidateRuleFields);
export type TriggerRuleCandidate = z.infer<typeof TriggerRuleCandidateSchema>;

/** A frozen rule snapshot: the candidate plus its own canonical hash. */
export const TriggerRuleSnapshotSchema = z.strictObject({
  ...candidateRuleFields,
  snapshot_hash: HashIdSchema,
});
export type TriggerRuleSnapshot = z.infer<typeof TriggerRuleSnapshotSchema>;

/** A fixed template pin plus the content hash it was resolved at. */
export const TriggerTemplatePinSchema = z.strictObject({
  template_id: TemplateIdSchema,
  version: VersionNumberSchema,
  content_hash: HashIdSchema,
});
export type TriggerTemplatePin = z.infer<typeof TriggerTemplatePinSchema>;

/** A resource identity whose id is the existing `VARCHAR`/numeric string form. */
export const TriggerResourceSchema = z.strictObject({
  type: ResourceTypeSchema,
  id: z.string().regex(/^[1-9]\d{0,15}$/),
});
export type TriggerResource = z.infer<typeof TriggerResourceSchema>;

const triggerCandidateFields = {
  kind: z.literal('trigger_candidate'),
  internal: z.literal(true),
  /** Nothing was written, applied or made effective by producing this value. */
  persisted: z.literal(false),
  applied: z.literal(false),
  effective: z.literal(false),
  status: z.literal('candidate'),
  resource: TriggerResourceSchema,
  config_revision: RevisionSchema,
  /** The B2C `TemplateCollectionPlan` identity this candidate was derived from. */
  plan_identity: HashIdSchema,
  templates: z.array(TriggerTemplatePinSchema).min(1),
  rules: z.array(TriggerRuleCandidateSchema),
};

/** All resolved rules of one resource revision, still a candidate. */
export const TriggerRuleCandidateSetSchema = z.strictObject(triggerCandidateFields);
export type TriggerRuleCandidateSet = z.infer<typeof TriggerRuleCandidateSetSchema>;

/**
 * The immutable resource rule snapshot a later mount package may persist. It is
 * explicitly a candidate of an **application** as well: `applied`/`effective`
 * stay false and only external applied evidence (a fence check) can justify
 * treating it as in effect.
 */
export const TriggerResourceSnapshotSchema = z.strictObject({
  ...triggerCandidateFields,
  kind: z.literal('template_trigger_snapshot'),
  rules: z.array(TriggerRuleSnapshotSchema),
  snapshot_hash: HashIdSchema,
});
export type TriggerResourceSnapshot = z.infer<typeof TriggerResourceSnapshotSchema>;

/**
 * Trusted application evidence: what the binding row actually reports. A
 * snapshot may be evaluated for a resource only when this names the same
 * resource/revision/plan and reports `applied`.
 */
export const TriggerAppliedEvidenceSchema = z.strictObject({
  resource: z.strictObject({ type: ResourceTypeSchema, id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  applied_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  plan_identity: HashIdSchema,
  application_status: z.enum(['pending', 'applied', 'failed']),
});
export type TriggerAppliedEvidence = z.infer<typeof TriggerAppliedEvidenceSchema>;

/** One scalar sample as the evaluator consumes it; the quality gates stay the accepted ones. */
export const TriggerSampleSchema = z.strictObject({
  metric: MetricRefSchema,
  unit: UnitSchema,
  value: ScalarValueSchema,
  observed_at: z.iso.datetime().regex(/:\d{2}(?:\.\d{1,3})?Z$/),
  dimensions: z.record(z.string(), z.string().min(1)),
  quality: QualitySchema,
  accuracy: AccuracySchema,
  coverage: z.number().min(0).max(1),
  /** The slice this sample covers; required by the windowed aggregations. */
  window: z.strictObject({
    from: z.iso.datetime().regex(/:\d{2}(?:\.\d{1,3})?Z$/),
    to: z.iso.datetime().regex(/:\d{2}(?:\.\d{1,3})?Z$/),
  }).nullable(),
});
export type TriggerSample = z.infer<typeof TriggerSampleSchema>;

export type TriggerRuleVersionInput = z.input<typeof TriggerRuleVersionSchema>;


/** Persisted event evidence DTO. Source sample time is distinct from evaluation time. */
const EpisodeEvidenceSchema = z.strictObject({
  business:z.enum(['healthy','problem','unknown']), quality:z.enum(['good','partial','unknown']),
  reason:z.string(),nodata:z.boolean(),value:z.number().nullable(),
  dimensions:z.record(z.string(),z.string()).nullable(),at:TimestampSchema,
});
export const TemplateTriggerEpisodeSchema = z.strictObject({
  episode_id:HashIdSchema,identity_hash:HashIdSchema,resource:TriggerResourceSchema,
  rule_id:RuleIdSchema,version:VersionNumberSchema,body_hash:HashIdSchema,scope:TemplateTriggerScopeSchema,
  state:z.enum(['open','closed']),occurrence:z.number().int().nonnegative(),opened_at:TimestampSchema,
  closed_at:TimestampSchema.nullable(),recovery_count:z.union([z.literal(0),z.literal(1)]),
  last:EpisodeEvidenceSchema,
  opened:z.strictObject({item:TriggerItemIdentitySchema,metric:MetricRefSchema,value:z.number().nullable(),reason:z.string(),at:TimestampSchema}),
  unknown_segments:z.array(z.strictObject({from:TimestampSchema,to:TimestampSchema.nullable(),reason:z.string()})),
  unknown_open_from:TimestampSchema.nullable(),
});
export const TemplateTriggerOpeningSchema = z.strictObject({sample_ids:z.array(z.string()),attempt_ids:z.array(z.string()),
  unit:UnitSchema,dimensions:z.record(z.string(),z.string()),samples:z.array(TriggerSampleSchema.extend({id:z.string()}))});
