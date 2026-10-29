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
  ResourceBindingCandidateInputSchema,
  type HashId, type ResourceBindingCandidate, type TemplatePin,
} from '../../contracts/metrics/templates.js';
import type { Capability } from '../../contracts/metrics/index.js';
import { checkApplicability, type ApplicabilityCheck } from '../packages/applicability.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import {
  canManageResource, canReadResource, MysqlResourceRelationStore, type ResourceRelationStore,
} from '../../resources/resource-service.js';
import { configurationInventory } from '../config/inventory.js';
import type { CollectorAccess } from '../scheduler/service.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { PolicyError, RefSchema, metricKey, refKey, rule, type Ref } from '../policy/model.js';
import {
  CAPABILITY_EVIDENCE_TTL_MS, CapabilityEvidenceError, probeIntentDigest,
  readCapabilityEvidence, writeCapabilityEvidence, type CapabilityEvidenceExecutor,
  type CapabilityEvidenceIdentity,
} from '../bindings/capability-evidence.js';
import { trustedTargetIdentity } from '../bindings/target-identity.js';
import { MysqlPolicyStore } from '../policy/store.js';
import type { TemplateVersionReadPort } from '../bindings/preflight.js';
import {
  resolveTemplateBinding, type ResolvedTemplateBinding, type ResolvedTemplateItem,
} from '../bindings/resolve.js';
import { buildTemplateCollectionPlan, type TemplateCollectionPlan } from '../bindings/plan.js';
import { issueTrialReceipt, type TrialReceiptItem } from '../bindings/trial-receipt-issuer.js';
import { writeTrialReceipt } from '../bindings/trial-receipt-writer.js';
import { decodeBindingPayload, type DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import { BindingTransactionError } from '../bindings/transaction-guard.js';
import type { BindingApplicationOutcome } from '../bindings/transaction-adapter.js';
import type { BindingSqlConnection, TrustedBindingInputs } from '../bindings/mysql-host.js';
import { MySqlTemplateRepository, type TemplateSqlConnection, type TemplateSqlPool } from './mysql-repository.js';
import type { TemplateRepository } from './repository.js';
import { repinTemplateVersion, type RepinResult } from './repin.js';
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
  | 'TEMPLATE_BINDING_ALREADY_BOUND'
  | 'TEMPLATE_BINDING_PROBE_FAILED'
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

/** One real read-only capability fact from the bootstrap probe. */
export type TemplateProbeCapability = Capability;

/**
 * The bootstrap probe answer. It is not a review, a trial, an application or a
 * binding: it is exactly the capability facts one bounded read-only probe
 * observed for this resource and exact candidate intent.
 */
export interface TemplateProbeResult {
  template: true;
  resource: Ref;
  revision: number;
  probed_at: string;
  expires_at: string;
  capabilities: TemplateProbeCapability[];
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

export interface TemplateOperationState {
  state: 'committed' | 'pending' | 'absent';
  operation: {
    resource: Ref;
    target_revision: number;
    candidate_digest: HashId;
    resolution_identity: HashId;
    status: 'committed' | 'unknown' | 'pending';
  } | null;
}

export interface TemplateBindingStatus {
  source: 'template' | 'package' | 'unbound';
  revision: number | null;
  application: { status: string; applied_revision: number | null; reported_at: string | null; error_code: string | null } | null;
  template_pins: TemplatePin[];
  pending: DecodedTemplateBindingPayload['pending'] | null;
  /**
   * The stored per-resource choice: the exact overrides and group the binding was
   * published with. An editor round-trips from this, never from a resolved plan,
   * so an unedited field cannot be silently reset.
   */
  configuration: { overrides: Record<string, unknown>; group_id: string | null } | null;
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

/**
 * One transaction over the whole re-pin publication sequence. Every accepted
 * repository operation already runs on the connection it is given; sharing one
 * connection means a refusal at any boundary rolls back the item versions, the
 * draft, the version, the current pointer and their audit chain together.
 */
export interface TemplatePublication {
  transaction<T>(
    run: (repository: TemplateRepository) => Promise<T>,
    /** The last live-grant read, immediately before the commit that publishes. */
    beforeCommit?: (connection: TemplateSqlConnection) => Promise<void>,
  ): Promise<T>;
}

export function mysqlTemplatePublication(pool: Pool): TemplatePublication {
  return {
    async transaction<T>(
      run: (repository: TemplateRepository) => Promise<T>,
      beforeCommit?: (connection: TemplateSqlConnection) => Promise<void>,
    ): Promise<T> {
      const connection = await (pool as unknown as TemplateSqlPool).getConnection();
      // Only a confirmed commit or rollback makes the connection reusable.
      let reusable = false;
      try {
        // A plain current read for the pre-commit grant check; see
        // `ActorContextService.revalidateActorOn`.
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        try {
          const result = await run(new MySqlTemplateRepository(connectionTemplatePool(connection)));
          // The repository writes above can wait on locks; the final grant is
          // read on this same connection, after them, so the commit itself is
          // the last persistence step rather than an unchecked one.
          await beforeCommit?.(connection);
          await connection.commit();
          reusable = true;
          return result;
        } catch (error) {
          try { await connection.rollback(); reusable = true; } catch { /* discard instead */ }
          throw error;
        }
      } finally {
        if (reusable) connection.release(); else connection.destroy();
      }
    },
  };
}

export interface TemplateBindingDeps {
  readonly pool: () => Pool | null;
  readonly registry: PackageRegistry;
  /** Same collector access the scheduler uses; credentials never leave it. */
  readonly access: CollectorAccess;
  readonly clock?: () => Date;
  readonly inventory?: (ref: Ref) => Promise<Resource | null>;
  /**
   * The live actor source (the accepted session re-read). A request actor is a
   * snapshot; every boundary that can wait for a lock re-reads it here instead
   * of re-checking the snapshot. Without it the service fails closed.
   */
  readonly reload?: (actor: ActorContext) => Promise<ActorContext>;
  /**
   * The same live actor re-read on a connection the caller already holds. Used
   * at persistence boundaries so the check does not take a second connection
   * from the pool while a transaction is open. Falls back to `reload`.
   */
  readonly reloadOn?: (actor: ActorContext, executor: Pick<BindingSqlConnection, 'execute'>) => Promise<ActorContext>;
  /** The accepted resource relation store; tests inject a controlled boundary. */
  readonly relations?: ResourceRelationStore;
  /** Where a re-pin publishes; defaults to one MySQL transaction on `pool`. */
  readonly templatePublication?: TemplatePublication;
}

export type TemplateRepinResult = RepinResult | { unchanged: true; template_id: string; version: number };

interface TrustedContext {
  resource: Resource;
  group: unknown;
  capabilities: unknown;
  /** The exact target + credential version these facts belong to. */
  targetIdentity: string;
  at: string;
}

export class TemplateBindingService {
  private readonly relations: ResourceRelationStore;

  constructor(private readonly deps: TemplateBindingDeps) {
    this.relations = deps.relations ?? new MysqlResourceRelationStore();
  }

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
  async assertAccess(
    actor: ActorContext, ref: Ref, write: boolean,
    executor?: Pick<BindingSqlConnection, 'execute'>,
  ): Promise<void> {
    RefSchema.parse(ref);
    if (!(write ? canManageResource(actor, ref) : canReadResource(actor, ref))) fail('TEMPLATE_BINDING_FORBIDDEN', 403);
    const exists = executor && this.relations.existsOn
      ? await this.relations.existsOn(executor, ref)
      : await this.relations.exists(ref);
    if (!exists) fail('TEMPLATE_BINDING_RESOURCE_NOT_FOUND', 404);
  }

  /**
   * The live grant at a boundary that waited (lock, admission, remote IO). It is
   * never answered from the actor the request arrived with: session revocation,
   * a changed permission set and a narrowed resource boundary are all read again.
   */
  private async live(actor: ActorContext): Promise<ActorContext> {
    const reload = this.deps.reload;
    if (!reload) fail('TEMPLATE_BINDING_STORE_UNAVAILABLE', 503);
    return reload(actor);
  }

  /**
   * The live grant at a persistence boundary: when the caller already holds the
   * connection, both the session re-read and the relation check run on it, so no
   * second connection is taken from the pool while a transaction is open.
   */
  private async liveOn(
    actor: ActorContext, executor: Pick<BindingSqlConnection, 'execute'>,
  ): Promise<ActorContext> {
    const reloadOn = this.deps.reloadOn;
    return reloadOn ? reloadOn(actor, executor) : this.live(actor);
  }

  /** The exact candidate a request names; `revision` is the base, never the target. */
  private candidate(ref: Ref, body: unknown): ResourceBindingCandidate {
    const input = (body ?? {}) as { template_pins?: unknown; overrides?: unknown; group_id?: unknown; expected_revision?: unknown };
    if (typeof input !== 'object') fail('TEMPLATE_BINDING_INPUT_INVALID');
    // The request candidate may name base revision 0 (an unbound resource's
    // first binding); stored payloads stay strictly positive.
    const parsed = ResourceBindingCandidateInputSchema.safeParse({
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
  private async context(ref: Ref, candidate: ResourceBindingCandidate, actorId: number,
    recover = false): Promise<TrustedContext> {
    const pool = this.pool();
    return this.contextOn({ execute: (sql, values) => pool.execute(sql, values as any[]) as Promise<[unknown, unknown]> },
      ref, candidate, actorId, recover);
  }

  private async contextOn(
    connection: Pick<BindingSqlConnection, 'execute'>, ref: Ref, candidate: ResourceBindingCandidate,
    actorId: number, recover = false,
  ): Promise<TrustedContext> {
    const resource = await this.inventory(ref);
    if (!resource) fail('TEMPLATE_BINDING_RESOURCE_NOT_FOUND', 404);
    let group: unknown = null;
    if (candidate.group_id) {
      const [rows] = await connection.execute('SELECT payload FROM metric_policy_groups WHERE id = ?', [candidate.group_id]) as unknown as [RowDataPacket[], unknown];
      group = rows[0] ? decode(rows[0].payload) : null;
    }
    // The exact target/credential version these facts belong to; a rewritten
    // target or a rotated credential is a different identity, never the same facts.
    let targetIdentity: string | null;
    try { targetIdentity = await trustedTargetIdentity(connection, ref); }
    catch { throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE'); }
    if (targetIdentity === null) fail('TEMPLATE_BINDING_RESOURCE_NOT_FOUND', 404);
    const [caps] = await connection.execute('SELECT capabilities FROM metric_policy_bindings WHERE resource_key = ?',
      [refKey(ref)]) as unknown as [RowDataPacket[], unknown];
    // A stored binding is the only capability authority for a bound resource.
    // An unbound resource has no row at all; its bootstrap context comes from the
    // exact, unexpired read-only probe evidence for this candidate intent.
    const capabilities = caps[0]
      ? decode(caps[0].capabilities)
      : await this.bootstrapCapabilities(connection, ref, candidate, actorId, targetIdentity, recover);
    return { resource: resource!, group, capabilities, targetIdentity, at: this.now().toISOString() };
  }

  /** The exact evidence identity a bootstrap probe writes for this candidate. */
  private evidenceIdentity(
    ref: Ref, candidate: ResourceBindingCandidate, actorId: number, targetIdentity: string,
  ): CapabilityEvidenceIdentity {
    return {
      resource: ref, revision: candidate.revision,
      template_pins: candidate.template_pins,
      credential_ref: credentialReference(ref),
      target_identity: targetIdentity,
      actor_id: actorId,
      intent_digest: probeIntentDigest(candidate),
    };
  }

  /**
   * Read bootstrap evidence for an unbound resource. A missing row is the only
   * "nothing was probed" answer; expired/corrupted evidence is a refusal, never
   * an implicit absence that would let a later step pretend it was verified.
   *
   * `recover` is used by the explicit probe only: it must be able to re-acquire
   * real facts when the stored row expired or is unparsable, so those two are
   * treated as "probe again" rather than a refusal. A storage error is not: an
   * unreadable store is still a failure, and an old row is never re-dated or
   * promoted to support.
   */
  private async bootstrapCapabilities(
    connection: Pick<BindingSqlConnection, 'execute'>, ref: Ref, candidate: ResourceBindingCandidate,
    actorId: number, targetIdentity: string, recover: boolean,
  ): Promise<Capability[]> {
    try {
      const record = await readCapabilityEvidence(
        connection as { execute: CapabilityEvidenceExecutor['execute'] },
        this.evidenceIdentity(ref, candidate, actorId, targetIdentity), this.now().getTime(),
      );
      return record === null ? [] : record.capabilities;
    } catch (error) {
      if (recover && error instanceof CapabilityEvidenceError
        && (error.code === 'CAPABILITY_EVIDENCE_EXPIRED' || error.code === 'CAPABILITY_EVIDENCE_INVALID')) {
        return [];
      }
      throw error;
    }
  }

  private async resolve(ref: Ref, candidate: ResourceBindingCandidate, actorId: number, recover = false) {
    const context = await this.context(ref, candidate, actorId, recover);
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
      // A target rewrite or credential rotation between trial and apply makes the
      // receipt's dependency identity differ, so the host refuses the stale trial.
      target_identity: context.targetIdentity,
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
    const { context, resolution, plan } = await this.resolve(ref, candidate, actor.userId);
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

  /**
   * Bootstrap capability acquisition for an unbound resource.
   *
   * This is deliberately not the formal trial: it only runs bounded read-only
   * requests through already registered implementations, pinned versions and a
   * trusted applicable target, and it persists the capability facts it actually
   * observed. It never writes a binding, revision, receipt, audit or applied
   * marker, and it never accepts a client-reported capability. The original
   * activation predicate still decides whether the resulting preview/trial may
   * enable anything.
   */
  async probe(actor: ActorContext, ref: Ref, body: unknown): Promise<TemplateProbeResult> {
    await this.assertAccess(actor, ref, true);
    const candidate = this.candidate(ref, body);
    // A bound resource already has a capability authority; bootstrap evidence
    // must never be substituted for its published facts.
    const [bound] = await this.pool().execute(
      'SELECT 1 FROM metric_policy_bindings WHERE resource_key = ? LIMIT 1', [refKey(ref)],
    ) as unknown as [RowDataPacket[], unknown];
    if (bound[0]) fail('TEMPLATE_BINDING_ALREADY_BOUND', 409);

    // Parameters/settings come from the exact pins; capabilities still come only
    // from the real probe below. The request cannot report support. Stored
    // evidence is read for the storage-error distinction only: an expired or
    // corrupt row must never stop the explicit re-probe that replaces it.
    const { context, resolution } = await this.resolve(ref, candidate, actor.userId, true);
    const selection = this.probeSelection(resolution);
    if (selection.length === 0) fail('TEMPLATE_BINDING_NOT_EXECUTABLE', 422);

    const reservation = await new MysqlScheduleStore(this.pool(), this.deps.registry).reserve(ref);
    if (!reservation) fail('TEMPLATE_BINDING_BUSY', 409);
    const authorize = async () => { await this.assertAccess(await this.live(actor), ref, true); };
    // Evidence persistence runs on the writer's own connection; the live grant is
    // re-read there after every wait (admission, pool, row lock, commit).
    const authorizeOn = async (executor?: Pick<BindingSqlConnection, 'execute'>) => {
      const current = executor ? await this.liveOn(actor, executor) : await this.live(actor);
      await this.assertAccess(current, ref, true, executor);
    };
    let executed: Array<{ release_ref: string; result: PackageResult }>;
    try {
      await authorize();
      executed = await this.probeExecute(ref, resolution, selection, authorize);
    } finally {
      await reservation.release();
    }
    await authorize();

    const capabilities = this.probeCapabilities(ref, resolution, executed);
    // Nothing observed, or every observed fact is unknown, proves no support: a
    // connection/parse failure is never stored as if something had been probed.
    if (capabilities.length === 0 || capabilities.every(capability => capability.status === 'unknown')) {
      fail('TEMPLATE_BINDING_PROBE_FAILED', 422);
    }
    const probedAt = this.now().toISOString();
    const expires = Math.min(
      Date.parse(probedAt) + CAPABILITY_EVIDENCE_TTL_MS,
      ...capabilities.map(capability => Date.parse(capability.valid_until)),
    );
    // An already-expired result enables nothing; it is never stored as evidence.
    if (!(expires > Date.parse(probedAt))) fail('TEMPLATE_BINDING_PROBE_FAILED', 422);

    const written = await writeCapabilityEvidence({
      ...this.evidenceIdentity(ref, candidate, actor.userId, context.targetIdentity),
      capabilities, probed_at: probedAt,
      expires_at: new Date(expires).toISOString(),
    }, { pool: this.deps.pool, authorize: authorizeOn });

    return {
      template: true, resource: ref, revision: candidate.revision,
      probed_at: written.record.probed_at, expires_at: written.record.expires_at,
      capabilities: written.record.capabilities,
    };
  }

  /** One bounded read per release; only items the resolution did not disable/reject. */
  private probeSelection(resolution: ResolvedTemplateBinding): Array<{
    release: ResolvedTemplateBinding['releases'][number]['release'];
    release_ref: string;
    collector_ids: string[];
    metric_keys: string[];
  }> {
    const selection: Array<{
      release: ResolvedTemplateBinding['releases'][number]['release'];
      release_ref: string;
      collector_ids: string[];
      metric_keys: string[];
    }> = [];
    for (const release of resolution.releases) {
      const items = release.collectors.flatMap(collector => collector.items)
        .filter(item => item.decision !== 'disabled' && item.decision !== 'unsupported');
      if (items.length === 0) continue;
      selection.push({
        release: { ...release.release }, release_ref: release.release_ref,
        collector_ids: [...new Set(items.map(item => item.collector_id))].sort(),
        metric_keys: [...new Set(items.map(item => metricKey(item.canonical_metric)))].sort(),
      });
    }
    return selection;
  }

  /**
   * The real read-only requests, one exact release at a time through the accepted
   * runner. The live grant is re-read before every actual request and after each
   * release returns, so a revocation cannot leave a read or its evidence behind.
   */
  private async probeExecute(
    ref: Ref,
    resolution: ResolvedTemplateBinding,
    selection: ReturnType<TemplateBindingService['probeSelection']>,
    authorize: () => Promise<void>,
  ): Promise<Array<{ release_ref: string; result: PackageResult }>> {
    const access = await this.deps.access.resolve(ref);
    if (access.resource.type !== ref.type || access.resource.id !== String(ref.id)) {
      fail('TEMPLATE_BINDING_PROBE_FAILED', 422);
    }
    await authorize();
    const settings = resolution.settings;
    const results: Array<{ release_ref: string; result: PackageResult }> = [];
    for (const entry of selection) {
      const result = await runPackage(this.deps.registry, {
        package: { ...entry.release }, credential_ref: access.credential_ref,
        overrides: {
          enabled: settings.enabled, interval_ms: settings.interval_ms, timeout_ms: settings.timeout_ms,
          stale_after_ms: settings.stale_after_ms, max_counter_gap_ms: settings.max_counter_gap_ms,
          max_rows: settings.max_rows,
        },
      }, {
        ...access, binding_id: refKey(ref),
        attempt_id: `template-probe:${refKey(ref)}:${resolution.revision}:${entry.release_ref}`,
        config_revision: Math.max(resolution.revision, 1), observed_at: this.now().toISOString(),
        clock: () => this.now().toISOString(), collector_ids: entry.collector_ids, metric_keys: entry.metric_keys,
        before_request: async () => { await authorize(); await access.assertCurrent?.(); },
      });
      // After the IO, before another release can reach the target.
      await authorize();
      results.push({ release_ref: entry.release_ref, result });
    }
    return results;
  }

  /** Exactly the probed item metrics/methods for this resource; nothing invented. */
  private probeCapabilities(
    ref: Ref,
    resolution: ResolvedTemplateBinding,
    executed: Array<{ release_ref: string; result: PackageResult }>,
  ): Capability[] {
    const wanted = new Map<string, true>();
    for (const release of resolution.releases) {
      for (const collector of release.collectors) {
        for (const item of collector.items) {
          if (item.decision === 'disabled' || item.decision === 'unsupported') continue;
          wanted.set(`${metricKey(item.canonical_metric)}|${item.method}`, true);
        }
      }
    }
    const seen = new Map<string, Capability>();
    for (const { result } of executed) {
      for (const capability of result.capabilities) {
        if (capability.resource_id !== String(ref.id)) continue;
        const key = `${metricKey(capability.metric)}|${capability.method}`;
        if (!wanted.has(key)) continue;
        seen.set(key, capability);
      }
    }
    return [...seen.values()].sort((left, right) =>
      (metricKey(left.metric) < metricKey(right.metric) ? -1 : metricKey(left.metric) > metricKey(right.metric) ? 1 : 0)
      || (left.method < right.method ? -1 : left.method > right.method ? 1 : 0));
  }

  /** Unit pairs declared by the mapping that produced each item's metric. */
  private unitChecks(plan: TemplateCollectionPlan): Map<string, { input_unit: string; output_unit: string }> {    const checks = new Map<string, { input_unit: string; output_unit: string }>();
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
  private async execute(ref: Ref, plan: TemplateCollectionPlan, revision: number,
    authorize: () => Promise<void>) {
    const access = await this.deps.access.resolve(ref);
    if (access.resource.type !== ref.type || access.resource.id !== String(ref.id)) fail('TEMPLATE_BINDING_TRIAL_FAILED', 422);
    // Resolving the credential may have waited; the grant that read it is not
    // necessarily the grant that issues the first request.
    await authorize();
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
        // The candidate names base 0 for a first binding, but no observation is
        // ever recorded at revision 0: the trial belongs to target revision 1.
        config_revision: Math.max(revision, 1), observed_at: this.now().toISOString(),
        clock: () => this.now().toISOString(), collector_ids: release.collector_ids, metric_keys: release.metric_keys,
        // Every actual read (including an adapter's additional reads and retries)
        // runs on a freshly re-read grant, never on the one that started the trial.
        before_request: async () => { await authorize(); await access.assertCurrent?.(); },
      });
      // After the IO, before any further release can reach the target.
      await authorize();
      results.push({ release_ref: release.release_ref, result });
    }
    return { results, access };
  }

  async trial(actor: ActorContext, ref: Ref, body: unknown): Promise<TemplateTrialResult> {
    await this.assertAccess(actor, ref, true);
    const candidate = this.candidate(ref, body);
    const receiptId = (body as { receipt_id?: unknown }).receipt_id;
    if (typeof receiptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receiptId)) fail('TEMPLATE_BINDING_INPUT_INVALID');
    const { context, resolution, plan } = await this.resolve(ref, candidate, actor.userId);
    if (!plan.executable) fail('TEMPLATE_BINDING_NOT_EXECUTABLE', 422);

    const reservation = await new MysqlScheduleStore(this.pool(), this.deps.registry).reserve(ref);
    if (!reservation) fail('TEMPLATE_BINDING_BUSY', 409);
    // Taking a lock, waiting on a resolution or issuing a read can all span a
    // revocation; every one of them re-reads the trusted session and boundary.
    const authorize = async () => { await this.assertAccess(await this.live(actor), ref, true); };
    // The persistence boundary runs on the writer's own connection (no second
    // pool connection while its transaction is open).
    const authorizeOn = async (executor?: Pick<BindingSqlConnection, 'execute'>) => {
      const current = executor ? await this.liveOn(actor, executor) : await this.live(actor);
      await this.assertAccess(current, ref, true, executor);
    };
    let executed: Awaited<ReturnType<TemplateBindingService['execute']>>;
    try {
      await authorize();
      executed = await this.execute(ref, plan, candidate.revision, authorize);
    } finally {
      await reservation!.release();
    }
    // The receipt is the persisted result of those reads: never write it on a
    // grant that no longer holds.
    await authorize();

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
      { pool: this.deps.pool, authorize: authorizeOn });
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
    // A session revoked inside the locked boundary is re-authentication, not a
    // generic host failure; keep that error to surface it unchanged.
    let authError: unknown;
    const store = new MysqlPolicyStore(this.deps.pool, {
      trustedInputs: connection => this.trustedInputs(connection, actor, candidate, error => { authError = error; }),
      trustedNow: () => this.now().toISOString(),
      registry: this.deps.registry,
    });
    try {
      return await store.templateGateway().apply({
        resource: ref, candidate, receipt_id: input.receipt_id, caller_key: input.caller_key,
      });
    } catch (error) {
      if (authError !== undefined) throw authError;
      throw error;
    }
  }

  /**
   * The host's trusted reads. `mandatoryItems` is every item of the pinned
   * immutable versions: the converted templates never contain an item that was
   * not resolved to a collectable capability, so all of them are required.
   */
  private trustedInputs(connection: BindingSqlConnection, actor: ActorContext, candidate: ResourceBindingCandidate,
    onAuthError?: (error: unknown) => void): TrustedBindingInputs {
    const versions = new MySqlTemplateRepository(connectionTemplatePool(connection));
    return {
      authorize: async resource => {
        const target = RefSchema.parse({ type: resource.type, id: Number(resource.id) });
        // The host calls this after its own row lock, and again after every
        // asynchronous read. Both answers come from a live grant, never from the
        // actor snapshot that opened the request.
        let current: ActorContext;
        try { current = await this.live(actor); }
        catch (error) { onAuthError?.(error); throw error; }
        const live = await this.contextOn(connection, target, candidate, actor.userId);
        const dep = this.dependencyDigest(live, credentialReference(target));
        return {
          allowed: canManageResource(current, target),
          cancelled: false,
          dependency_digest: dep,
        };
      },
      applicationContext: async resource => {
        const target = RefSchema.parse({ type: resource.type, id: Number(resource.id) });
        const context = await this.contextOn(connection, target, candidate, actor.userId);
        return { resource: context.resource, group: context.group, capabilities: context.capabilities, at: context.at,
          actor_id: actor.userId };
      },
      /**
       * Every item this exact configuration must prove. An explicitly disabled
       * setting or metric is not a required item: it never enters the plan, so
       * demanding trial evidence for it would make an honest disable impossible.
       * The set is derived from the trusted resolution (same pins, group and
       * capabilities as the enable decision), never from the request body.
       */
      mandatoryItems: async resource => {
        const target = RefSchema.parse({ type: resource.type, id: Number(resource.id) });
        const live = await this.contextOn(connection, target, candidate, actor.userId);
        const outcome = await resolveTemplateBinding(candidate, live, versions, this.deps.registry);
        if (outcome.kind !== 'template_resolution') throw new Error('TEMPLATE_BINDING_LEGACY_CANDIDATE');
        const items: Array<{ template_id: string; item_id: string; item_version: number }> = [];
        for (const release of outcome.releases) for (const collector of release.collectors) {
          for (const item of collector.items) {
            if (item.decision === 'disabled') continue;
            items.push({ template_id: item.template_id, item_id: item.item_id, item_version: item.item_version });
          }
        }
        if (items.length === 0) throw new Error('TEMPLATE_BINDING_NOT_EXECUTABLE');
        return items;
      },
      templateVersions: () => versions,
    };
  }

  /**
   * Publish a compatible version for this resource. The whole sequence is one
   * transaction, and the live grant is re-read after the read-only analysis and
   * before every write (item version, draft, version, current pointer), so a
   * revocation leaves no partial publication behind.
   */
  async repin(actor: ActorContext, ref: Ref, templateId: string): Promise<TemplateRepinResult> {
    await this.assertAccess(actor, ref, true);
    const authorize = async (executor?: Pick<BindingSqlConnection, 'execute'>): Promise<ActorContext> => {
      const current = executor ? await this.liveOn(actor, executor) : await this.live(actor);
      await this.assertAccess(current, ref, true, executor);
      return current;
    };
    const resource = await this.inventory(ref);
    if (!resource) fail('TEMPLATE_BINDING_RESOURCE_NOT_FOUND', 404);
    const publication = this.deps.templatePublication ?? mysqlTemplatePublication(this.pool());
    return publication.transaction(repository => repinTemplateVersion({
      repository, registry: this.deps.registry, templateId, resource,
      at: this.now().toISOString(), requestId: actor.requestId, actor, authorize,
    }), async connection => { await authorize(connection); });
  }

  /**
   * The native host's own operation record for one caller key. It is written in
   * the same transaction as the binding revision and its audit, so a committed
   * row is proof that intent was applied. A row for another resource is reported
   * absent (never disclosed), and the live grant is re-read after the read so a
   * revocation that lands during the query is still refused.
   */
  async operation(actor: ActorContext, ref: Ref, callerKey: string): Promise<TemplateOperationState> {
    await this.assertAccess(actor, ref, false);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerKey)) fail('TEMPLATE_BINDING_INPUT_INVALID');
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      `SELECT resource_key, target_revision, candidate_digest, resolution_identity, status
         FROM metric_policy_operations WHERE caller_key = ? LIMIT 2`, [callerKey]);
    // Decimal keys are binary in DDL; compare their UTF-8 text.
    const row = rows.find(candidate => String(candidate.resource_key) === refKey(ref));
    // A revoke that lands while the row is being read must not return its facts.
    await this.assertAccess(await this.live(actor), ref, false);
    if (!row) return { state: 'absent', operation: null };
    const rawStatus = String(row.status);
    const status = rawStatus === 'committed' ? 'committed' as const
      : rawStatus === 'unknown' ? 'unknown' as const : 'pending' as const;
    return { state: status === 'committed' ? 'committed' : 'pending', operation: {
      resource: ref, target_revision: Number(row.target_revision),
      candidate_digest: String(row.candidate_digest) as HashId,
      resolution_identity: String(row.resolution_identity) as HashId, status,
    } };
  }

  /** Read one binding row through the shared codec; a template row keeps its own shape. */
  async status(actor: ActorContext, ref: Ref): Promise<TemplateBindingStatus> {
    await this.assertAccess(actor, ref, false);
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      'SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    if (!rows[0]) {
      return { source: 'unbound', revision: null, application: null, template_pins: [], pending: null,
        configuration: null, effective: null, published_at: null };
    }
    const decoded = decodeBindingPayload(rows[0].payload);
    const configuration = { overrides: decoded.binding.overrides, group_id: decoded.binding.group_id };
    if (decoded.kind === 'legacy_published') {
      return {
        source: 'package', revision: decoded.binding.revision, application: decoded.application,
        template_pins: decoded.binding.template_pins, pending: null, configuration,
        effective: decoded.effective
          ? { revision: decoded.effective.revision, resolution_identity: String(decoded.effective.resolution_identity ?? '') }
          : null,
        published_at: typeof (decoded.payload as { published_at?: unknown }).published_at === 'string'
          ? (decoded.payload as { published_at: string }).published_at : null,
      };
    }
    return {
      source: 'template', revision: decoded.pending.target_revision, application: decoded.application,
      template_pins: decoded.binding.template_pins, pending: decoded.pending, configuration,
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
  if (error instanceof CapabilityEvidenceError) {
    // Corrupt/expired evidence is a refusal, never a silent "absent": the caller
    // must re-probe or fix the store instead of enabling from stale facts.
    return { status: 503, code: error.code };
  }
  if (error instanceof PolicyError) return { status: error.status, code: error.code };
  // The accepted guard's refusals are business answers: a permission refusal,
  // a stale revision/operation key, a changed dependency or an expired/consumed
  // receipt. None of them may collapse into a 500 the client would retry blindly.
  if (error instanceof BindingTransactionError) {
    if (error.code === 'TRANSACTION_FORBIDDEN') return { status: 403, code: 'TEMPLATE_BINDING_FORBIDDEN' };
    if (error.code === 'TRANSACTION_INPUT_INVALID') return { status: 400, code: error.code };
    if (error.code === 'TRANSACTION_AUTH_UNAVAILABLE' || error.code === 'TRANSACTION_OPERATION_UNAVAILABLE') {
      return { status: 503, code: error.code };
    }
    if (error.code.startsWith('TRANSACTION_RECEIPT_')) return { status: 422, code: error.code };
    return { status: 409, code: error.code };
  }
  return null;
};
