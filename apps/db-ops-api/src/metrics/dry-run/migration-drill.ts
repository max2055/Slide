/**
 * MAX-236 stage-11 isolated migration / rollback reference model.
 *
 * It answers one question for the three P0 resource classes (instance, server,
 * network_device): given a legacy identity snapshot, which identities may be
 * migrated, which keep the legacy read path, which block the object's cutover,
 * and — after apply + rollback — what proves history, credential references,
 * resource ACL, revisions and audit survived unchanged.
 *
 * It is a reference model, not a second source of truth:
 * - it never touches the platform schema, collector, evaluator, scheduler or API;
 * - every resource input here is a fixture, never a live platform row;
 * - a zero network-device platform therefore cannot make its scenario pass a
 *   real acceptance item — the network_device case is synthetic by definition.
 *
 * Disposition rules follow `08-d1-d8-contract-draft.md` §10 (D8) with the one
 * contradiction in that table resolved explicitly (see `dispose`):
 * "unit or semantics unclear" keeps the legacy path, while "cannot prove the
 * target/packaging safe" blocks the object. An identity is never migrated by
 * name similarity, unit conversion or a zero fill.
 */
import { createHash } from 'node:crypto';

export type ResourceType = 'instance' | 'server' | 'network_device';
export type Disposition = 'mapped' | 'keep-legacy' | 'blocked';

/** One legacy identity fact, as the read-only inventory reports it. */
export interface IdentityInput {
  resource_type: ResourceType;
  engine: string | null;
  old_id: string;
  unit: string;
  /** Explicit `migrateReference` target, or null when no equivalent is proven. */
  target_metric_id: string | null;
  target_unit: string | null;
  /** True only when the identity is enabled for THIS resource, not just catalogued. */
  in_scope: boolean;
  has_custom_sql: boolean;
  custom_sql_reviewed: boolean;
  /** More than one legacy id resolves to the same canonical metric, no provider chosen. */
  ambiguous_provider?: boolean;
  /** The explicit map names a target that the current catalog does not contain. */
  target_missing?: boolean;
}

export interface TemplatePin {
  template_id: string;
  version: number;
  content_hash: string;
}

export interface BindingRevision {
  revision: number;
  pins: TemplatePin[];
  /** Legacy single-package pin; retained so the old read path stays expressible. */
  package: string | null;
  /** Digest of the plan that produced this revision; null for pre-migration rows. */
  migration_digest: string | null;
  reason: string;
  at: string;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  resource_key: string;
  detail: Record<string, unknown>;
  at: string;
}

export interface DrillResource {
  resource_key: string;
  resource_type: ResourceType;
  engine: string | null;
  /** `credential:<id>` references only. A resolved secret is never a valid value. */
  credential_refs: string[];
  /** Resource-level ACL grants; migration must not add, remove or widen them. */
  acl: string[];
  /** Legacy history row counts per table. Read-only: never rewritten or deleted. */
  legacy_history: Record<string, number>;
  /** Append-only audit trail. Existing entries are immutable. */
  audit: AuditEntry[];
  /** Append-only binding revisions; the last entry is the current one. */
  revisions: BindingRevision[];
  /** Job identity per resource: exactly one executor, never two for the same series. */
  schedules: string[];
  /** Authoritative event ids; migration must not create or resolve any. */
  event_ids: string[];
}

export interface PlanRow {
  identity: string;
  in_scope: boolean;
  disposition: Disposition;
  reason: string;
  actions: string[];
}

export interface MigrationPlan {
  resource_key: string;
  resource_type: ResourceType;
  engine: string | null;
  /** The revision this plan was computed against; apply requires it to be current. */
  base_revision: number;
  rows: PlanRow[];
  /** Template pins the migrated scope installs; empty when nothing maps. */
  pins: TemplatePin[];
  cutover_allowed: boolean;
  blockers: string[];
  digest: string;
}

export interface ApplyOptions {
  actor: string;
  at: string;
  /** Injected failure point: proves the caller can keep the state untouched. */
  failAt?: 'before-write' | 'after-binding' | 'before-audit';
}

export interface ApplyResult {
  resource: DrillResource;
  outcome: 'applied' | 'noop';
  written: number;
}

export interface RollbackOptions {
  target_revision: number;
  /** The revision the caller observed; a concurrent writer must not be overwritten. */
  expected_current_revision: number;
  actor: string;
  at: string;
}

export interface PreservationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreservationReport {
  ok: boolean;
  checks: PreservationCheck[];
}

export class DrillRefusal extends Error {
  constructor(message: string, readonly blockers: string[]) {
    super(message);
    this.name = 'DrillRefusal';
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic encoding                                              */
/* ------------------------------------------------------------------ */

const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
};

export const digestOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;

export const identityKey = (input: IdentityInput): string =>
  `${input.resource_type}:${input.engine ?? '-'}:${input.old_id}`;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* ------------------------------------------------------------------ */
/* Disposition                                                         */
/* ------------------------------------------------------------------ */

/**
 * D8 disposition for one identity.
 *
 * The draft's §10 lists "旧自定义 SQL 未审核" in both `keep-legacy` and
 * `blocked`. This model resolves it the only way both rows can hold: the
 * legacy path stays readable (keep-legacy behaviour) but the identity blocks
 * its object's cutover, so the effective disposition is `blocked`. The same
 * applies to a target the explicit map names but the catalog lacks.
 */
export function dispose(input: IdentityInput): PlanRow {
  const identity = identityKey(input);
  if (!input.in_scope) {
    return { identity, in_scope: false, disposition: 'keep-legacy',
      reason: 'catalog-only identity: not enabled for this resource',
      actions: ['no migration action; keep the legacy catalog row read-only'] };
  }
  if (input.target_missing) {
    return { identity, in_scope: true, disposition: 'blocked',
      reason: 'MAPPING_TARGET_MISSING: the explicit map names a canonical metric the catalog lacks',
      actions: ['do not cut this object over', 'fix the mapping constant or retire the identity explicitly'] };
  }
  if (input.has_custom_sql && !input.custom_sql_reviewed) {
    return { identity, in_scope: true, disposition: 'blocked',
      reason: 'CUSTOM_SQL_REVIEW_REQUIRED: unreviewed legacy SQL cannot become a published item',
      actions: ['keep the legacy path read-only', 'block this object until the SQL is reviewed or the identity retired'] };
  }
  if (input.target_metric_id === null) {
    return { identity, in_scope: true, disposition: 'keep-legacy',
      reason: 'no proven equivalent; never substitute a ratio, host CPU or zero',
      actions: ['keep the legacy history readable', 'disable the legacy rule with an audit entry',
        'do not attach the identity to the new collection path'] };
  }
  // A named target with an unknown unit cannot be proven equivalent: an absent
  // unit is unknown, not "the same unit". Only an explicit, equal unit maps.
  if (input.target_unit === null) {
    return { identity, in_scope: true, disposition: 'keep-legacy',
      reason: 'CANONICAL_UNIT_UNPROVEN: the canonical target has no proven unit',
      actions: ['prove the canonical unit before planning this identity',
        'keep the legacy path read-only; no guessed or converted unit'] };
  }
  if (input.ambiguous_provider) {
    return { identity, in_scope: true, disposition: 'keep-legacy',
      reason: 'MANY_TO_ONE_MAPPING: several legacy ids share one canonical metric and no provider is chosen',
      actions: ['pick one provider or a namespace', 'never merge histories'] };
  }
  if (input.target_unit !== input.unit) {
    return { identity, in_scope: true, disposition: 'keep-legacy',
      reason: `UNIT_REVIEW_REQUIRED: legacy "${input.unit}" vs canonical "${input.target_unit}"`,
      actions: ['confirm an explicit equivalent-notation entry', 'no silent unit conversion or threshold re-basing'] };
  }
  return { identity, in_scope: true, disposition: 'mapped',
    reason: 'explicit mapping, identical unit, canonical target present',
    actions: ['create the new item/trigger on the canonical identity', 'keep legacy rows read-only; never re-point old history'] };
}

/**
 * An identity only applies to a resource in the same engine scope.
 *
 * Instances carry an engine identity: a postgresql identity can never
 * authorize a mysql plan (or the reverse). Server/device identities are
 * engine-agnostic by construction, so a resource of those classes must not
 * carry an engine and the identity must be engine-null as well.
 */
const engineInScope = (input: IdentityInput, resource: DrillResource): boolean =>
  resource.resource_type === 'instance'
    ? input.engine === resource.engine
    : input.engine === null;

/**
 * Build a deterministic plan. `objectBlockers` are resource-level facts the
 * inventory already reports (pin drift, rollout without binding, ...): they
 * stop THIS object's cutover without inventing an identity disposition.
 *
 * The digest binds the resource identity (key, type, engine), the base
 * revision, every disposition, the pins and the object blockers. A plan is
 * therefore not transferable to another resource, another engine or a newer
 * revision of the same resource.
 */
export function planMigration(
  resource: DrillResource,
  identities: IdentityInput[],
  options: { objectBlockers?: string[]; template?: TemplatePin | TemplatePin[] } = {},
): MigrationPlan {
  const rows = identities
    .filter(input => input.resource_type === resource.resource_type && engineInScope(input, resource))
    .map(dispose)
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const inScope = rows.filter(row => row.in_scope);
  const blocked = inScope.filter(row => row.disposition === 'blocked');
  const blockers = [...(options.objectBlockers ?? []).slice().sort(), ...blocked.map(row => row.identity)];
  const mapped = inScope.filter(row => row.disposition === 'mapped');
  const requested = options.template === undefined
    ? [] : Array.isArray(options.template) ? options.template : [options.template];
  const pins = mapped.length > 0 ? clone(requested) : [];
  const cutover_allowed = blockers.length === 0 && pins.length > 0;
  const plan = {
    resource_key: resource.resource_key,
    resource_type: resource.resource_type,
    engine: resource.engine,
    base_revision: currentRevision(resource).revision,
    rows,
    pins,
    cutover_allowed,
    blockers,
  };
  return { ...plan, digest: planDigest(plan) };
}

/** Recompute a plan's digest from its content; apply refuses a forged plan. */
export const planDigest = (plan: Omit<MigrationPlan, 'digest'>): string =>
  digestOf({
    resource_key: plan.resource_key,
    resource_type: plan.resource_type,
    engine: plan.engine,
    base_revision: plan.base_revision,
    rows: plan.rows,
    pins: plan.pins,
    blockers: plan.blockers,
    cutover_allowed: plan.cutover_allowed,
  });

/* ------------------------------------------------------------------ */
/* Apply / rollback                                                    */
/* ------------------------------------------------------------------ */

const currentRevision = (resource: DrillResource): BindingRevision => {
  const last = resource.revisions.at(-1);
  if (!last) throw new Error('DRILL_STATE_INVALID: resource has no binding revision');
  return last;
};

/**
 * Apply the plan as one new revision. The reference model is synchronous and
 * pure: it either returns the whole next state or throws, so a caller never
 * observes a half-written binding, pin set or audit entry.
 *
 * Order matters: a forged digest, a plan made for another resource/engine and
 * a stale base revision are all refused before anything is written. An exact
 * replay is a no-op only after the resource identity check, so a matching
 * digest can never be used to write a different resource.
 *
 * A matching digest is a hint, not replay proof: the current revision must be
 * the exact result this plan produced (its next revision, the same pin set and
 * no legacy package). Digest match with a drifted result is refused instead of
 * silently treated as a no-op, and a plan whose content changed no longer
 * matches its digest at all (`DRILL_PLAN_DIGEST_MISMATCH`).
 */
export function applyMigration(resource: DrillResource, plan: MigrationPlan, options: ApplyOptions): ApplyResult {
  if (planDigest(plan) !== plan.digest) {
    throw new DrillRefusal(`DRILL_PLAN_DIGEST_MISMATCH:${resource.resource_key}`, plan.blockers);
  }
  if (!plan.cutover_allowed) {
    throw new DrillRefusal(`DRILL_CUTOVER_BLOCKED:${resource.resource_key}`, plan.blockers);
  }
  if (plan.resource_key !== resource.resource_key
    || plan.resource_type !== resource.resource_type
    || plan.engine !== resource.engine) {
    throw new DrillRefusal(
      `DRILL_PLAN_RESOURCE_MISMATCH:${plan.resource_key}/${plan.engine}->${resource.resource_key}/${resource.engine}`,
      plan.blockers);
  }
  const current = currentRevision(resource);
  if (current.migration_digest === plan.digest) {
    // The digest alone is not replay proof: a legacy digest survives pin,
    // package or revision drift. Only the exact result of this plan — the
    // revision it creates, its pin set and no legacy package — may be a no-op.
    const exactReplay = current.revision === plan.base_revision + 1
      && current.package === null
      && sameJson(current.pins, plan.pins);
    if (exactReplay) {
      return { resource: clone(resource), outcome: 'noop', written: 0 };
    }
    throw new DrillRefusal(
      `DRILL_REPLAY_CONFLICT:${plan.base_revision}->${current.revision}`, plan.blockers);
  }
  if (current.revision !== plan.base_revision) {
    throw new DrillRefusal(
      `DRILL_PLAN_STALE:${plan.base_revision}->${current.revision}`, plan.blockers);
  }
  if (options.failAt === 'before-write') throw new DrillRefusal('DRILL_INJECTED_FAILURE:before-write', plan.blockers);

  const next = clone(resource);
  const nextRevision: BindingRevision = {
    revision: current.revision + 1,
    pins: clone(plan.pins),
    package: null,
    migration_digest: plan.digest,
    reason: `migrate ${plan.rows.filter(row => row.disposition === 'mapped').length} mapped identities`,
    at: options.at,
  };
  next.revisions.push(nextRevision);
  if (options.failAt === 'after-binding') throw new DrillRefusal('DRILL_INJECTED_FAILURE:after-binding', []);
  if (options.failAt === 'before-audit') throw new DrillRefusal('DRILL_INJECTED_FAILURE:before-audit', []);

  next.audit.push({
    id: Math.max(0, ...resource.audit.map(entry => entry.id)) + 1,
    actor: options.actor,
    action: 'migrate',
    resource_key: resource.resource_key,
    detail: { from_revision: current.revision, to_revision: nextRevision.revision, plan: plan.digest },
    at: options.at,
  });
  return { resource: next, outcome: 'applied', written: 1 };
}

/**
 * Roll back to a previous revision by appending a new one that points at the
 * old pin set. Content is never deleted and a multi-template combination is
 * never flattened into a single package.
 */
export function rollbackMigration(resource: DrillResource, options: RollbackOptions): ApplyResult {
  const target = resource.revisions.find(revision => revision.revision === options.target_revision);
  if (!target) throw new DrillRefusal(`DRILL_ROLLBACK_TARGET_MISSING:${options.target_revision}`, []);
  const current = currentRevision(resource);
  if (current.revision !== options.expected_current_revision) {
    throw new DrillRefusal(
      `DRILL_ROLLBACK_CONFLICT:${options.expected_current_revision}->${current.revision}`, []);
  }
  const next = clone(resource);
  const rolledBack: BindingRevision = {
    revision: current.revision + 1,
    pins: clone(target.pins),
    package: target.package,
    migration_digest: null,
    reason: `rollback to revision ${target.revision}`,
    at: options.at,
  };
  next.revisions.push(rolledBack);
  next.audit.push({
    id: Math.max(0, ...resource.audit.map(entry => entry.id)) + 1,
    actor: options.actor,
    action: 'rollback',
    resource_key: resource.resource_key,
    detail: { from_revision: current.revision, to_revision: rolledBack.revision, target_revision: target.revision },
    at: options.at,
  });
  return { resource: next, outcome: 'applied', written: 1 };
}

/* ------------------------------------------------------------------ */
/* Preservation                                                        */
/* ------------------------------------------------------------------ */

const sameJson = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * The five things the acceptance item names (history, credential reference,
 * permission, revision, audit), plus the two invariants that make a rollback
 * safe (one executor per resource, no re-fired event) and the multi-template
 * no-flatten rule.
 */
export function verifyPreservation(before: DrillResource, after: DrillResource): PreservationReport {
  const checks: PreservationCheck[] = [];
  checks.push({ name: 'history', ok: sameJson(before.legacy_history, after.legacy_history),
    detail: `legacy rows ${JSON.stringify(before.legacy_history)} -> ${JSON.stringify(after.legacy_history)}` });
  const credentialShape = after.credential_refs.every(ref => /^credential:[^:]+$/.test(ref));
  checks.push({ name: 'credentials', ok: sameJson(before.credential_refs, after.credential_refs) && credentialShape,
    detail: after.credential_refs.join(',') || 'none' });
  checks.push({ name: 'acl', ok: sameJson(before.acl, after.acl), detail: after.acl.join(',') || 'none' });
  const auditPrefix = before.audit.every((entry, index) => sameJson(entry, after.audit[index]));
  checks.push({ name: 'audit-append-only', ok: auditPrefix && after.audit.length >= before.audit.length,
    detail: `${before.audit.length} -> ${after.audit.length} entries` });
  const revisionsKept = before.revisions.every(old => after.revisions.some(next => sameJson(old, next)));
  checks.push({ name: 'revisions-retained', ok: revisionsKept,
    detail: `${before.revisions.length} -> ${after.revisions.length} revisions` });
  checks.push({ name: 'single-executor', ok: after.schedules.length === 1,
    detail: after.schedules.join(',') || 'none' });
  checks.push({ name: 'events-unchanged', ok: sameJson(before.event_ids, after.event_ids),
    detail: `${before.event_ids.length} event(s)` });
  return { ok: checks.every(check => check.ok), checks };
}

/* ------------------------------------------------------------------ */
/* Scenario runner                                                     */
/* ------------------------------------------------------------------ */

export interface DrillScenario {
  name: string;
  resource: DrillResource;
  identities: IdentityInput[];
  objectBlockers?: string[];
  template: TemplatePin | TemplatePin[];
  /** Revision to roll back to; defaults to the revision before the migration. */
  rollback_to?: number;
  actor: string;
  at: string;
}

export interface DrillResult {
  name: string;
  cutover_allowed: boolean;
  blockers: string[];
  plan_digest: string;
  applied: 'applied' | 'refused' | 'noop';
  idempotent: boolean;
  /** The rollback revision reproduces the target pin set and package exactly. */
  rollback_exact: boolean;
  /** A multi-template target comes back with the same pins, never flattened. */
  multi_template_preserved: boolean;
  preserved: boolean;
  checks: PreservationCheck[];
  error?: string;
}

/**
 * Forward drill: plan -> apply -> verify -> re-apply (must be a no-op) ->
 * rollback -> verify. A blocked object must refuse without touching state.
 */
export function runScenario(scenario: DrillScenario): DrillResult {
  const plan = planMigration(scenario.resource, scenario.identities, {
    objectBlockers: scenario.objectBlockers,
    template: scenario.template,
  });
  const base: DrillResult = {
    name: scenario.name,
    cutover_allowed: plan.cutover_allowed,
    blockers: plan.blockers,
    plan_digest: plan.digest,
    applied: 'refused',
    idempotent: false,
    rollback_exact: false,
    multi_template_preserved: false,
    preserved: false,
    checks: [],
  };
  if (!plan.cutover_allowed) {
    let error: string | undefined;
    try {
      applyMigration(scenario.resource, plan, { actor: scenario.actor, at: scenario.at });
      error = 'expected a refusal';
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const unchanged = verifyPreservation(scenario.resource, scenario.resource);
    return { ...base, error, checks: unchanged.checks, preserved: unchanged.ok };
  }

  const before = scenario.resource;
  const applied = applyMigration(before, plan, { actor: scenario.actor, at: scenario.at });
  const forward = verifyPreservation(before, applied.resource);
  const again = applyMigration(applied.resource, plan, { actor: scenario.actor, at: scenario.at });
  const idempotent = again.outcome === 'noop'
    && sameJson(again.resource.revisions, applied.resource.revisions)
    && sameJson(again.resource.audit, applied.resource.audit);
  const target = scenario.rollback_to ?? currentRevision(before).revision;
  const rolledBack = rollbackMigration(applied.resource, {
    target_revision: target,
    expected_current_revision: currentRevision(applied.resource).revision,
    actor: scenario.actor,
    at: scenario.at,
  });
  const backward = verifyPreservation(applied.resource, rolledBack.resource);
  const targetRevision = applied.resource.revisions.find(revision => revision.revision === target);
  const rolledBackRevision = rolledBack.resource.revisions.at(-1);
  // A rollback must reproduce the target pin set exactly. A multi-template
  // combination may never come back as a single package or a truncated list.
  const exactPins = targetRevision !== undefined && rolledBackRevision !== undefined
    && sameJson(targetRevision.pins, rolledBackRevision.pins)
    && targetRevision.package === rolledBackRevision.package;
  const checks = [...forward.checks, ...backward.checks];
  return {
    ...base,
    applied: applied.outcome,
    idempotent,
    rollback_exact: exactPins,
    multi_template_preserved: exactPins && (targetRevision?.pins.length ?? 0) > 1,
    preserved: forward.ok && backward.ok && idempotent && exactPins,
    checks,
  };
}
