/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R1 — production entry for a fixed-pin
 * template binding.
 *
 * This is the seam between the accepted internal packages (B1 preflight, B2A
 * candidate compile, B2C resolution/plan, B2D transaction adapter, B2E MySQL
 * host, B2G receipt issuer) and the running product:
 *
 * - pinned template versions are read from the persistent `metric_template_*`
 *   tables through the accepted `MySqlTemplateRepository`;
 * - `preview` re-walks preflight → compile → resolve → plan and reports every
 *   item's decision, exact release and applicability to the live target version;
 * - `trial` executes that plan against the real target (read-only, through the
 *   same `CollectorAccess` the scheduler uses), turns per-item evidence into a
 *   v2 receipt and writes the receipt — it never writes formal observations;
 * - `apply` hands the raw candidate plus the receipt to the accepted host, which
 *   takes the policy lock, re-derives all three identities and stages one
 *   `templates-v1` payload with its audit.
 *
 * The service never resolves a credential itself, never writes a binding outside
 * the host transaction, and never turns a storage/driver message into a
 * response: every rejection is one stable code.
 */
import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../../auth/actor-context.js';
import type { Resource } from '../../contracts/metrics/index.js';
import {
  ResourceBindingCandidateSchema,
  type HashId, type ResourceBindingCandidate, type TemplateItemVersion, type TemplatePin, type TemplateVersion,
} from '../../contracts/metrics/templates.js';
import { checkApplicability, type ApplicabilityCheck } from '../packages/applicability.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { canManageResource, canReadResource, MysqlResourceRelationStore } from '../../resources/resource-service.js';
import { configurationInventory } from '../config/inventory.js';
import type { CollectorAccess } from '../scheduler/service.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { PolicyError, RefSchema, refKey, rule, type Ref } from '../policy/model.js';
import { MysqlPolicyStore } from '../policy/store.js';
import type { TemplateVersionReadPort } from '../bindings/preflight.js';
import {
  resolveTemplateBinding, type ResolvedTemplateBinding, type ResolvedTemplateItem,
} from '../bindings/resolve.js';
import { buildTemplateCollectionPlan, type TemplateCollectionPlan } from '../bindings/plan.js';
import { issueTrialReceipt, type TrialReceiptItem } from '../bindings/trial-receipt-issuer.js';
import { writeTrialReceipt } from '../bindings/trial-receipt-writer.js';
import { decodeBindingPayload, type DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import type { BindingApplicationOutcome } from '../bindings/transaction-adapter.js';
import type { BindingSqlConnection, TrustedBindingInputs } from '../bindings/mysql-host.js';
import { MySqlTemplateRepository, type TemplateSqlConnection, type TemplateSqlPool } from './mysql-repository.js';
import { runPackage, type PackageResult } from '../packages/runner.js';

export type TemplateBindingErrorCode =
  | 'TEMPLATE_BINDING_INPUT_INVALID'
  | 'TEMPLATE_BINDING_FORBIDDEN'
  | 'TEMPLATE_BINDING_RESOURCE_NOT_FOUND'
  | 'TEMPLATE_BINDING_LEGACY_CANDIDATE'
  | 'TEMPLATE_BINDING_NOT_EXECUTABLE'
  | 'TEMPLATE_BINDING_TRIAL_FAILED'
  | 'TEMPLATE_BINDING_BUSY'
  | 'TEMPLATE_BINDING_RECEIPT_INVALID'
  | 'TEMPLATE_BINDING_STORE_UNAVAILABLE';

export class TemplateBindingError extends Error {
  constructor(public readonly code: TemplateBindingErrorCode, public readonly status = 400) {
    super(code);
    this.name = 'TemplateBindingError';
  }
}

/** The receipt lifetime the issuer stamps; the guard rejects at/after expiry. */
export const TRIAL_RECEIPT_TTL_MS = 600_000;

const fail = (code: TemplateBindingErrorCode, status = 400): never => { throw new TemplateBindingError(code, status); };

export interface TemplateBindingItemView {
  template_id: string;
  item_id: string;
  item_version: number;
  canonical_metric: ResolvedTemplateItem['canonical_metric'];
  unit: string;
  dimensions: Record<string, string>;
  release: ResolvedTemplateItem['release'];
  release_ref: string;
  collector_id: string;
  implementation_id: string;
  enabled: boolean;
  decision: ResolvedTemplateItem['decision'];
  capability: ResolvedTemplateItem['capability']['status'];
}

export interface TemplateBindingPreview {
  template: true;
  resource: Ref;
  revision: number;
  resolution_identity: HashId;
  executable: boolean;
  settings: ResolvedTemplateBinding['settings'];
  parameters: ResolvedTemplateBinding['templates'];
  releases: Array<{
    release: ResolvedTemplateItem['release'];
    release_ref: string;
    interval_ms: number;
    timeout_ms: number;
    collector_ids: string[];
    metric_keys: string[];
    requests_per_hour_estimate: number;
    applicability: ApplicabilityCheck[];
  }>;
  items: TemplateBindingItemView[];
  excluded: ResolvedTemplateBinding['excluded'];
  budget: TemplateCollectionPlan['budget'];
  plan: TemplateCollectionPlan;
}

export interface TemplateTrialSample {
  template_id: string;
  item_id: string;
  item_version: number;
  metric: ResolvedTemplateItem['canonical_metric'];
  value: unknown;
  unit: string;
  observed_at: string;
  quality: unknown;
  read: { collector_id: string; attempt_ids: string[]; status: string };
  transform: { version: string };
  unit_check: { input_unit: string; output_unit: string };
}

export interface TemplateTrialResult {
  trial: true;
  persisted: false;
  decision: PackageResult['decision'] | 'unsupported';
  receipt_id: string;
  expires_at: string;
  resolution_identity: HashId;
  items: TrialReceiptItem[];
  optional_exclusions: Array<Pick<TrialReceiptItem, 'template_id' | 'item_id' | 'item_version'>>;
  samples: TemplateTrialSample[];
  attempts: PackageResult['attempts'];
  releases: Array<{ release_ref: string; decision: string }>;
}

export interface TemplateBindingStatus {
  source: 'template' | 'package' | 'unbound';
  revision: number | null;
  application: { status: string; applied_revision: number | null; reported_at: string | null; error_code: string | null } | null;
  template_pins: TemplatePin[];
  pending: DecodedTemplateBindingPayload['pending'] | null;
  effective: { revision: number; resolution_identity: string } | null;
  published_at: string | null;
}

const hash = (value: unknown): HashId => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;

/** The accepted collector access derives exactly this non-secret reference from the resource. */
const credentialReference = (ref: Ref): string => `credential:asset-${ref.type}-${ref.id}`;

/**
 * Wrap one already-leased host connection as a read-only template pool. The
 * accepted repository leases through this port; begin/commit/release are no-ops
 * so a read can never end the host's transaction.
 */
export function connectionTemplatePool(connection: BindingSqlConnection): TemplateSqlPool {
  const view: TemplateSqlConnection = {
    execute: (sql, values) => connection.execute(sql, values) as Promise<[unknown, unknown]>,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    destroy: () => undefined,
  };
  return { getConnection: async () => view };
}

/** A pool-backed read port for preview/trial, where no host transaction exists. */
export function poolTemplatePort(pool: Pool): MySqlTemplateRepository {
  return new MySqlTemplateRepository(pool as unknown as TemplateSqlPool);
}

export interface TemplateBindingDeps {
  readonly pool: () => Pool | null;
  readonly registry: PackageRegistry;
  /** Same collector access the scheduler uses; credentials never leave it. */
  readonly access: CollectorAccess;
  readonly clock?: () => Date;
  readonly inventory?: (ref: Ref) => Promise<Resource | null>;
}

interface TrustedContext {
  resource: Resource;
  group: unknown;
  capabilities: unknown;
  at: string;
}

export class TemplateBindingService {
  private readonly relations = new MysqlResourceRelationStore();

  constructor(private readonly deps: TemplateBindingDeps) {}

  private pool(): Pool {
    const pool = this.deps.pool();
    if (!pool) return fail('TEMPLATE_BINDING_STORE_UNAVAILABLE', 503);
    return pool;
  }

  private now(): Date { return (this.deps.clock ?? (() => new Date()))(); }

  private inventory(ref: Ref): Promise<Resource | null> {
    return (this.deps.inventory ?? configurationInventory)(ref);
  }

  /** Read authorization uses the accepted resource relation; write needs manage. */
  async assertAccess(actor: ActorContext, ref: Ref, write: boolean): Promise<void> {
    RefSchema.parse(ref);
    if (!(write ? canManageResource(actor, ref) : canReadResource(actor, ref))) fail('TEMPLATE_BINDING_FORBIDDEN', 403);
    if (!await this.relations.exists(ref)) fail('TEMPLATE_BINDING_RESOURCE_NOT_FOUND', 404);
  }

  /** The exact candidate a request names; `revision` is the base, never the target. */
  private candidate(ref: Ref, body: unknown): ResourceBindingCandidate {
    const input = (body ?? {}) as { template_pins?: unknown; overrides?: unknown; group_id?: unknown; expected_revision?: unknown };
    if (typeof input !== 'object') fail('TEMPLATE_BINDING_INPUT_INVALID');
    const parsed = ResourceBindingCandidateSchema.safeParse({
      resource: ref,
      package: null,
      group_id: input.group_id ?? null,
      overrides: input.overrides ?? {},
      revision: input.expected_revision,
      template_pins: input.template_pins,
    });
    if (!parsed.success) fail('TEMPLATE_BINDING_INPUT_INVALID');
    return parsed.data;
  }

  /** Trusted B2C context read once per operation; nothing here comes from the request. */
  private async context(ref: Ref, groupId: string | null): Promise<TrustedContext> {
    const pool = this.pool();
    return this.contextOn({ execute: (sql, values) => pool.execute(sql, values as any[]) as Promise<[unknown, unknown]> }, ref, groupId);
  }

  private async contextOn(connection: Pick<BindingSqlConnection, 'execute'>, ref: Ref, groupId: string | null): Promise<TrustedContext> {
    const resource = await this.inventory(ref);
    if (!resource) fail('TEMPLATE_BINDING_RESOURCE_NOT_FOUND', 404);
    let group: unknown = null;
    if (groupId) {
      const [rows] = await connection.execute('SELECT payload FROM metric_policy_groups WHERE id = ?', [groupId]) as unknown as [RowDataPacket[], unknown];
      group = rows[0] ? decode(rows[0].payload) : null;
    }
    const [caps] = await connection.execute('SELECT capabilities FROM metric_policy_bindings WHERE resource_key = ?',
      [refKey(ref)]) as unknown as [RowDataPacket[], unknown];
    return { resource: resource!, group, capabilities: caps[0] ? decode(caps[0].capabilities) : [], at: this.now().toISOString() };
  }

  private async resolve(ref: Ref, candidate: ResourceBindingCandidate) {
    const context = await this.context(ref, candidate.group_id);
    const outcome = await resolveTemplateBinding(candidate, context, poolTemplatePort(this.pool()), this.deps.registry);
    if (outcome.kind !== 'template_resolution') fail('TEMPLATE_BINDING_LEGACY_CANDIDATE');
    const resolution = outcome as ResolvedTemplateBinding;
    return { context, resolution, plan: buildTemplateCollectionPlan(resolution) };
  }

  /** The dependency identity the receipt and the guard both compare. */
  dependencyDigest(context: TrustedContext, credentialRef: string): HashId {
    // Attribute observation timestamps are re-stamped on every inventory read;
    // hashing them would make two reads of unchanged state differ. Only the
    // values (with their source) are dependency identity.
    const attributes = Object.fromEntries(Object.entries(context.resource.attributes)
      .map(([name, attribute]) => [name, { value: attribute?.value ?? null, source: attribute?.source ?? null }]));
    return hash({
      resource: { type: context.resource.type, id: context.resource.id, attributes },
      group: context.group, capabilities: context.capabilities, credential_ref: credentialRef,
    });
  }

  private items(resolution: ResolvedTemplateBinding): TemplateBindingItemView[] {
    return resolution.releases.flatMap(release => release.collectors.flatMap(collector => collector.items))
      .map(item => ({
        template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
        canonical_metric: item.canonical_metric, unit: item.unit, dimensions: item.dimensions,
        release: item.release, release_ref: item.release_ref, collector_id: item.collector_id,
        implementation_id: item.implementation_id, enabled: item.enabled, decision: item.decision,
        capability: item.capability.status,
      }))
      .sort((left, right) => left.template_id.localeCompare(right.template_id)
        || left.item_id.localeCompare(right.item_id) || left.item_version - right.item_version);
  }

  async preview(actor: ActorContext, ref: Ref, body: unknown): Promise<TemplateBindingPreview> {
    await this.assertAccess(actor, ref, true);
    const candidate = this.candidate(ref, body);
    const { context, resolution, plan } = await this.resolve(ref, candidate);
    // The same trusted inventory the resolution saw; a fresh read would stamp
    // observed_at after `at` and make every applicability check look unknown.
    const at = context.at;
    const resource = context.resource;
    const releases = plan.releases.map(entry => {
      const release = this.deps.registry.get({ ...entry.release });
      return {
        release: entry.release, release_ref: entry.release_ref, interval_ms: entry.interval_ms,
        timeout_ms: entry.timeout_ms, collector_ids: entry.collector_ids, metric_keys: entry.metric_keys,
        requests_per_hour_estimate: entry.requests_per_hour_estimate,
        applicability: checkApplicability(release.package, resource as Resource, at),
      };
    });
    return {
      template: true, resource: ref, revision: candidate.revision,
      resolution_identity: plan.identity, executable: plan.executable, settings: resolution.settings,
      parameters: resolution.templates, releases, items: this.items(resolution), excluded: resolution.excluded,
      budget: plan.budget, plan,
    };
  }

  /** Unit pairs declared by the mapping that produced each item's metric. */
  private unitChecks(plan: TemplateCollectionPlan): Map<string, { input_unit: string; output_unit: string }> {
    const checks = new Map<string, { input_unit: string; output_unit: string }>();
    for (const entry of plan.releases) {
      const release = this.deps.registry.get({ ...entry.release });
      for (const collector of release.package.collectors) for (const mapping of collector.mappings) {
        checks.set(`${collector.id}|${mapping.metric.id}@${mapping.metric.semantic_version}`,
          { input_unit: mapping.input_unit, output_unit: mapping.output_unit });
      }
    }
    return checks;
  }

  /**
   * Execute the template plan against the live target, read-only. One exact
   * release at a time through the existing runner, restricted to the plan's own
   * collector and metric selection; nothing is persisted.
   */
  private async execute(ref: Ref, plan: TemplateCollectionPlan, revision: number) {
    const access = await this.deps.access.resolve(ref);
    if (access.resource.type !== ref.type || access.resource.id !== String(ref.id)) fail('TEMPLATE_BINDING_TRIAL_FAILED', 422);
    const settings = plan.settings;
    const results: Array<{ release_ref: string; result: PackageResult }> = [];
    for (const release of plan.releases) {
      if (release.steps.length === 0) continue;
      const result = await runPackage(this.deps.registry, {
        package: { ...release.release }, credential_ref: access.credential_ref,
        overrides: { enabled: settings.enabled, interval_ms: settings.interval_ms, timeout_ms: settings.timeout_ms,
          stale_after_ms: settings.stale_after_ms, max_counter_gap_ms: settings.max_counter_gap_ms, max_rows: settings.max_rows },
      }, {
        ...access, binding_id: refKey(ref), attempt_id: `template-trial:${refKey(ref)}:${revision}:${release.release_ref}`,
        config_revision: revision, observed_at: this.now().toISOString(),
        clock: () => this.now().toISOString(), collector_ids: release.collector_ids, metric_keys: release.metric_keys,
        before_request: async () => { await access.assertCurrent?.(); },
      });
      results.push({ release_ref: release.release_ref, result });
    }
    return { results, access };
  }

  async trial(actor: ActorContext, ref: Ref, body: unknown): Promise<TemplateTrialResult> {
    await this.assertAccess(actor, ref, true);
    const candidate = this.candidate(ref, body);
    const receiptId = (body as { receipt_id?: unknown }).receipt_id;
    if (typeof receiptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receiptId)) fail('TEMPLATE_BINDING_INPUT_INVALID');
    const { context, resolution, plan } = await this.resolve(ref, candidate);
    if (!plan.executable) fail('TEMPLATE_BINDING_NOT_EXECUTABLE', 422);

    const reservation = await new MysqlScheduleStore(this.pool(), this.deps.registry).reserve(ref);
    if (!reservation) fail('TEMPLATE_BINDING_BUSY', 409);
    let executed: Awaited<ReturnType<TemplateBindingService['execute']>>;
    try {
      executed = await this.execute(ref, plan, candidate.revision);
    } finally {
      await reservation!.release();
    }

    type Computation = PackageResult['observations'][number];
    const observations = new Map<string, Computation>();
    const attemptIds = new Map<string, string[]>();
    for (const { result } of executed.results) {
      for (const computation of result.observations) {
        observations.set(`${computation.observation.metric.id}@${computation.observation.metric.semantic_version}`, computation);
      }
      for (const attempt of result.attempts) {
        const collectorId = String((attempt as { collector_id?: string }).collector_id ?? '');
        attemptIds.set(collectorId, [...(attemptIds.get(collectorId) ?? []), attempt.id]);
      }
    }
    const units = this.unitChecks(plan);
    const samples: TemplateTrialSample[] = [];
    const evidence = this.items(resolution).map(item => {
      const key = `${item.canonical_metric.id}@${item.canonical_metric.semantic_version}`;
      const observation = observations.get(key)?.observation;
      const unitCheck = units.get(`${item.collector_id}|${key}`);
      const phases = {
        read: Boolean(observation) && (attemptIds.get(item.collector_id)?.length ?? 0) > 0,
        transform: Boolean(observation?.versions.transform_version),
        unit: Boolean(observation) && unitCheck !== undefined && unitCheck.output_unit === item.unit,
      };
      if (observation) {
        samples.push({
          template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
          metric: item.canonical_metric, value: observation.value, unit: observation.unit,
          observed_at: observation.observed_at, quality: observation.quality,
          read: { collector_id: item.collector_id, attempt_ids: attemptIds.get(item.collector_id) ?? [],
            status: observation.value === null ? 'no_value' : 'succeeded' },
          transform: { version: observation.versions.transform_version },
          unit_check: unitCheck ?? { input_unit: item.unit, output_unit: observation.unit },
        });
      }
      // A selected item without complete read/transform/unit evidence is an
      // explicit optional exclusion; it never becomes a fabricated pass.
      return {
        template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
        status: 'qualified' as const,
        optional: !(phases.read && phases.transform && phases.unit),
        phases,
      };
    });

    const dependencyDigest = this.dependencyDigest(context, credentialReference(ref));
    const issued = await issueTrialReceipt({ resource: ref, candidate, receipt_id: receiptId }, {
      context, dependencyDigest, templates: poolTemplatePort(this.pool()), registry: this.deps.registry,
      evidence: { read: async () => evidence }, now: () => this.now().toISOString(), ttlMs: TRIAL_RECEIPT_TTL_MS,
    });
    const written = await writeTrialReceipt(
      { receipt_id: issued.receipt_id, payload: issued.payload as unknown as Record<string, unknown> },
      { pool: this.deps.pool });
    if (written.kind === 'collision') fail('TEMPLATE_BINDING_RECEIPT_INVALID', 409);

    const decisions = executed.results.map(entry => entry.result.decision);
    return {
      trial: true, persisted: false,
      decision: decisions.length === 0 ? 'unsupported'
        : decisions.every(value => value === 'attempted') ? 'attempted' : decisions[0],
      receipt_id: issued.receipt_id, expires_at: issued.payload.expires_at,
      resolution_identity: issued.payload.resolution_identity,
      items: issued.payload.items,
      optional_exclusions: issued.payload.optional_exclusions
        .map(({ template_id, item_id, item_version }) => ({ template_id, item_id, item_version })),
      samples, attempts: executed.results.flatMap(entry => entry.result.attempts),
      releases: executed.results.map(entry => ({ release_ref: entry.release_ref, decision: entry.result.decision })),
    };
  }

  /**
   * Hand the raw candidate and its receipt to the accepted host. The host owns
   * the lock, the three identities, the CAS and the audit; this method supplies
   * only trusted reads bound to the host's own connection.
   */
  async apply(actor: ActorContext, ref: Ref, body: unknown): Promise<BindingApplicationOutcome> {
    await this.assertAccess(actor, ref, true);
    const candidate = this.candidate(ref, body);
    const input = body as { receipt_id?: unknown; caller_key?: unknown };
    if (typeof input.receipt_id !== 'string' || typeof input.caller_key !== 'string') fail('TEMPLATE_BINDING_INPUT_INVALID');
    const store = new MysqlPolicyStore(this.deps.pool, {
      trustedInputs: connection => this.trustedInputs(connection, actor, candidate),
      trustedNow: () => this.now().toISOString(),
      registry: this.deps.registry,
    });
    return store.templateGateway().apply({
      resource: ref, candidate, receipt_id: input.receipt_id, caller_key: input.caller_key,
    });
  }

  /**
   * The host's trusted reads. `mandatoryItems` is every item of the pinned
   * immutable versions: the converted templates never contain an item that was
   * not resolved to a collectable capability, so all of them are required.
   */
  private trustedInputs(connection: BindingSqlConnection, actor: ActorContext, candidate: ResourceBindingCandidate): TrustedBindingInputs {
    const versions = new MySqlTemplateRepository(connectionTemplatePool(connection));
    return {
      authorize: async resource => {
        const target = RefSchema.parse({ type: resource.type, id: Number(resource.id) });
        const context = await this.contextOn(connection, target, candidate.group_id);
        return {
          allowed: canManageResource(actor, target),
          cancelled: false,
          dependency_digest: this.dependencyDigest(context, credentialReference(target)),
        };
      },
      applicationContext: async resource => {
        const target = RefSchema.parse({ type: resource.type, id: Number(resource.id) });
        const context = await this.contextOn(connection, target, candidate.group_id);
        return { resource: context.resource, group: context.group, capabilities: context.capabilities, at: context.at,
          actor_id: actor.userId };
      },
      mandatoryItems: async () => {
        const items: Array<{ template_id: string; item_id: string; item_version: number }> = [];
        for (const pin of candidate.template_pins) {
          let version: TemplateVersion | null;
          try { version = await versions.getVersion(pin.template_id, pin.version); }
          catch { throw new Error('TEMPLATE_BINDING_STORE_UNAVAILABLE'); }
          if (version === null) throw new Error('TEMPLATE_BINDING_STORE_UNAVAILABLE');
          for (const item of version.items as TemplateItemVersion[]) {
            items.push({ template_id: item.template_id, item_id: item.item_id, item_version: item.version });
          }
        }
        return items;
      },
      templateVersions: () => versions,
    };
  }

  /** Read one binding row through the shared codec; a template row keeps its own shape. */
  async status(actor: ActorContext, ref: Ref): Promise<TemplateBindingStatus> {
    await this.assertAccess(actor, ref, false);
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      'SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    if (!rows[0]) {
      return { source: 'unbound', revision: null, application: null, template_pins: [], pending: null,
        effective: null, published_at: null };
    }
    const decoded = decodeBindingPayload(rows[0].payload);
    if (decoded.kind === 'legacy_published') {
      return {
        source: 'package', revision: decoded.binding.revision, application: decoded.application,
        template_pins: decoded.binding.template_pins, pending: null,
        effective: decoded.effective
          ? { revision: decoded.effective.revision, resolution_identity: String(decoded.effective.resolution_identity ?? '') }
          : null,
        published_at: typeof (decoded.payload as { published_at?: unknown }).published_at === 'string'
          ? (decoded.payload as { published_at: string }).published_at : null,
      };
    }
    return {
      source: 'template', revision: decoded.pending.target_revision, application: decoded.application,
      template_pins: decoded.binding.template_pins, pending: decoded.pending,
      effective: decoded.effective
        ? { revision: decoded.effective.revision, resolution_identity: decoded.effective.resolution_identity }
        : null,
      published_at: decoded.published_at,
    };
  }
}

/** Stable mapping for the route layer; never a driver message. */
export const templateBindingErrorStatus = (error: unknown): { status: number; code: string } | null => {
  if (error instanceof TemplateBindingError) return { status: error.status, code: error.code };
  if (error instanceof PolicyError) return { status: error.status, code: error.code };
  return null;
};
