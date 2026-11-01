import { validSourceSnapshot } from '../rollout/source-history.js';
import { instanceAccessLifecycle } from '../../resources/instance-access-lifecycle.js';
import { validateBindings, type Resource } from '../../contracts/metrics/index.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { dueMetricIds } from '../../collection-scheduler.js';
import { MysqlWorkflowStore, type ClaimedJob, type JobExecutionContext } from '../../workflows/worker-runtime.js';
import { MysqlMetricStorage, seriesHash } from '../storage.js';
import { RolloutControl, type Ticket } from '../rollout/control.js';
import type { PackageRegistry } from '../packages/model.js';
import type { CounterState } from '../state.js';
import { type Published, type Ref, type Group, RefSchema, refKey, rule } from '../policy/model.js';
import { resolvePolicy } from '../policy/resolver.js';
import { bindingReadCode, readLegacyPublished, readStoredBinding, TEMPLATE_BINDING_UNSUPPORTED } from '../bindings/package-reader.js';
import { decodeBindingPayload, encodeTemplateAppliedPayload, type DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import { evaluateTemplateSamples } from '../triggers/runtime.js';
import type { TemplateCollectionPlan } from '../bindings/plan.js';
import type { PackageResult } from '../packages/runner.js';
import { compilePlan, hash, jitterFor, type CollectorPlan } from './compiler.js';
import { assetCollectionEnabled } from '../config/effective-state.js';
import { trustedTargetIdentity } from '../bindings/target-identity.js';
import { stable } from '../packages/model.js';

export const JOB_TYPE = 'metrics.collect';
/** A manual collection is a distinct job type in the same queue and worker lanes. */
export const COLLECT_NOW_JOB_TYPE = 'metrics.collect_now';
export const GLOBAL_CONCURRENCY = 4;
const decode = <T>(v: T | string): T => typeof v === 'string' ? JSON.parse(v) : v;
export interface ExecutionSnapshot { published: Published; plan: CollectorPlan; states: Map<string, CounterState>; tickets?: Map<string, Ticket> }
export interface Reservation { connection: PoolConnection; release(): Promise<void> }
/** One executable template row: the decoded envelope, never a synthesized package view. */
export interface TemplateScheduleItem {
  resource_key: string;
  decoded: DecodedTemplateBindingPayload;
}
/** A scan separates legal legacy rows, executable template rows and refused rows. */
export interface ScheduleScan {
  published: Published[]; templates: TemplateScheduleItem[]; rejected: Array<{ resource_key: string; code: string }>;
}
/** One template execution snapshot; the plan is the pending revision's exact plan. */
export interface TemplateExecutionSnapshot {
  decoded: DecodedTemplateBindingPayload;
  plan: TemplateCollectionPlan;
  states: Map<string, CounterState>;
  /** Formal publication tickets captured before remote IO; empty until formalized. */
  tickets: Map<string, Ticket>;
}

/* --- manual collection tasks ---------------------------------------------- */

export type CollectTaskState = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type CollectOutcome = 'sampled' | 'no_samples' | 'failed' | 'cancelled' | 'unknown';
/** The immutable sample identity a task's own job committed; never another run's latest value. */
export interface CollectSample {
  id: string;
  metric: { id: string; semantic_version: string };
  unit: string;
  value: unknown;
  observed_at: string;
  quality: unknown;
  attempt_ids: string[];
}
export interface CollectAttempt { id: string; collector_id: string | null; status: string }
export interface CollectTask {
  id: string;
  resource: Ref;
  caller_key: string;
  revision: number;
  resolution_identity: string;
  job_id: string;
  state: CollectTaskState;
  outcome: CollectOutcome | null;
  error_code: string | null;
  samples: CollectSample[];
  attempts: CollectAttempt[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** The live workflow queue state; a terminal journal state always wins. */
  job_state: string | null;
}
export interface CollectAdmissionInput {
  ref: Ref;
  actorId: number;
  sessionVersion: number;
  callerKey: string;
  expectedRevision: number;
}
export interface CollectAdmissionResult { created: boolean; task: CollectTask }

async function collectIntentDigest(c: PoolConnection, ref: Ref, decoded: DecodedTemplateBindingPayload): Promise<string> {
  // Keep the target and its credentials stable until this transaction commits.
  const table = ref.type === 'instance' ? 'database_instances' : ref.type === 'server' ? 'servers' : 'network_devices';
  // The exclusive device lock also fences a new credential row's foreign-key check.
  await c.execute(`SELECT id FROM ${table} WHERE id = ? ${ref.type === 'network_device' ? 'FOR UPDATE' : 'FOR SHARE'}`, [ref.id]);
  if (ref.type === 'network_device') {
    await c.execute('SELECT device_id FROM network_device_credentials WHERE device_id = ? FOR SHARE', [ref.id]);
  }
  const targetIdentity = await trustedTargetIdentity(c as never, ref);
  rule(targetIdentity !== null, 'COLLECT_RESOURCE_NOT_FOUND', 404);
  return `sha256:${createHash('sha256').update(stable({
    format: 'max238.collect-intent.v1', resource: refKey(ref), revision: decoded.binding.revision,
    resolution_identity: decoded.pending.resolution_identity, plan: decoded.pending.plan.identity,
    pins: decoded.binding.template_pins, credential_ref: `credential:asset-${ref.type}-${ref.id}`,
    target_identity: targetIdentity,
  })).digest('hex')}`;
}

/** Short transactions share the policy publication lock. Never hold a transaction during remote IO. */
export class MysqlScheduleStore {
  constructor(readonly pool: Pool, private readonly registry: PackageRegistry,
    private readonly rolloutTicket?: Ticket | 'production') {}
  /**
   * A mixed scan is isolated per row: template/corrupt rows are reported with a
   * stable code and never enter the legacy compile/enqueue/formalization path,
   * while every legal legacy row still ticks.
   */
  async scan(): Promise<ScheduleScan> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT resource_key, payload FROM metric_policy_bindings ORDER BY resource_key');
    const published: Published[] = [], templates: TemplateScheduleItem[] = [], rejected: ScheduleScan['rejected'] = [];
    for (const row of rows) {
      try {
        const stored = readStoredBinding(row.payload);
        if (stored.source === 'template') {
          // Only an executable pending plan is a collection candidate; a disabled
          // or blocked resolution is reported and never compiled as a package.
          if (!stored.template.pending.plan.executable) {
            rejected.push({ resource_key: String(row.resource_key), code: 'TEMPLATE_PLAN_NOT_EXECUTABLE' });
          } else templates.push({ resource_key: String(row.resource_key), decoded: stored.template });
        } else published.push(stored.published);
      } catch (error) {
        rejected.push({ resource_key: String(row.resource_key), code: bindingReadCode(error) ?? 'BINDING_ROW_UNREADABLE' });
      }
    }
    return { published, templates, rejected };
  }
  /** An all-or-nothing legacy view for callers that must not skip a non-legacy row. */
  async list(): Promise<Published[]> {
    const scan = await this.scan();
    if (scan.rejected.length) throw new Error(scan.rejected[0].code);
    // An all-or-nothing legacy view must not silently skip a template row.
    if (scan.templates.length) throw new Error(TEMPLATE_BINDING_UNSUPPORTED);
    return scan.published;
  }
  private async transaction<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [lock] = await c.query<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
      rule(lock.length === 1, 'SCHEDULE_STORE_UNAVAILABLE');
      const result = await fn(c); await c.commit(); return result;
    } catch (e) { await c.rollback().catch(() => undefined); throw e; } finally { c.release(); }
  }
  async current(c: Pick<Pool, 'execute'> | PoolConnection, ref: Ref): Promise<Published | null> {
    const [rows] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    return rows[0] ? readLegacyPublished(rows[0].payload) : null;
  }
  async enqueue(published: Published, now: number): Promise<boolean> {
    // Direct enqueue must discern its input before any resource I/O; a template
    // candidate or a corrupt snapshot never reaches the legacy compiler or queue.
    const input = readLegacyPublished(published);
    if (input.binding.resource.type === 'instance') {
      try { await instanceAccessLifecycle.assertAvailable(input.binding.resource.id); } catch { return false; }
    }
    // Compile before any write; corrupt configuration never queues a job or advances applied revision.
    const plan = compilePlan(this.registry, input.resolved), ref = input.binding.resource;
    rule(plan.revision === input.binding.revision && refKey(ref) === refKey(plan.resource), 'PLAN_IDENTITY');
    return this.transaction(async c => {
      const current = await this.current(c, ref);
      if (!current || current.binding.revision !== plan.revision) return false;
      if (!await assetCollectionEnabled(c, ref, true)) return false;
      // Read application state under the publication lock, not from the scan's
      // potentially stale snapshot. The first disabled job must still be applied
      // by a fenced worker; subsequent scans need no periodic no-IO jobs.
      if (!current.resolved.settings.enabled && current.application.status === 'applied'
        && current.application.applied_revision === plan.revision) return false;
      const [coordination] = await c.execute<RowDataPacket[]>(
        'SELECT phase,revision FROM metric_rollout_resources WHERE resource_key = ? FOR UPDATE', [refKey(ref)],
      );
      if (coordination[0]?.phase === 'legacy' && Number(coordination[0].revision) >= plan.revision) return false;
      const [rows] = await c.execute<RowDataPacket[]>('SELECT * FROM metric_schedule WHERE resource_key = ? FOR UPDATE', [refKey(ref)]);
      const row = rows[0];
      let next = row ? Number(row.next_due_ms) : now + plan.jitterMs;
      let pending = (row?.job_id ?? null) as string | null;
      if (row && Number(row.revision) !== plan.revision) {
        pending = null;
        next = row.last_end_ms === null ? now + plan.jitterMs : Number(row.last_end_ms) + plan.intervalMs;
      }
      if (pending) {
        const [jobs] = await c.execute<RowDataPacket[]>('SELECT state FROM workflow_jobs WHERE id = ?', [pending]);
        if (jobs.length && !['completed', 'dead_letter', 'cancelled'].includes(jobs[0].state)) return false;
        // Exhausted retries resume only at the next normal cadence, never an immediate hot loop.
        pending = null; next = Math.max(next, now + plan.intervalMs);
      }
      await c.execute(`INSERT INTO metric_schedule (resource_key, revision, next_due_ms, states) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE states = IF(revision = VALUES(revision), states, VALUES(states)), revision = VALUES(revision), next_due_ms = VALUES(next_due_ms), job_id = ?`,
      [refKey(ref), plan.revision, next, '{}', pending]);
      // A disabled plan still gets applied by a real fenced worker, without collection requests.
      if (next > now) return false;
      if (row?.last_end_ms !== null && row?.last_end_ms !== undefined && !dueMetricIds([{ id: 'cycle', default_interval: plan.intervalMs / 1000 }],
        new Map([['cycle', Number(row.last_end_ms)]]), now).length) return false;
      const id = randomUUID();
      const queue = new MysqlWorkflowStore(() => c as never);
      await queue.enqueue({ id, type: JOB_TYPE, schemaVersion: 1, payload: { resource: ref, revision: plan.revision },
        idempotencyKey: `metric:${refKey(ref)}:${id}`, maxAttempts: 3, availableAt: new Date(now) });
      await c.execute('UPDATE metric_schedule SET job_id = ? WHERE resource_key = ?', [id, refKey(ref)]);
      return true;
    });
  }
  /** Connection locks outlive cancellation/lease loss until the in-flight request actually settles. */
  async reserve(ref: Ref): Promise<Reservation | null> {
    const c = await this.pool.getConnection();
    const held: string[] = [];
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try { for (const name of held.reverse()) await c.execute('SELECT RELEASE_LOCK(?)', [name]); }
      catch (error) { c.destroy(); throw error; }
      c.release();
    };
    try {
      const [db] = await c.query<RowDataPacket[]>('SELECT DATABASE() AS name');
      const prefix = hash(String(db[0].name)).slice(0, 16);
      const acquire = async (name: string) => {
        const [rows] = await c.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [name]);
        if (Number(rows[0].acquired) !== 1) return false;
        held.push(name); return true;
      };
      if (!await acquire(`metric:${prefix}:resource:${hash(refKey(ref)).slice(0, 24)}`)) { await release(); return null; }
      for (let i = 0; i < GLOBAL_CONCURRENCY; i++) if (await acquire(`metric:${prefix}:slot:${i}`)) return { connection: c, release };
      await release(); return null;
    } catch (e) { await release(); throw e; }
  }
  private async valid(c: PoolConnection, ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext): Promise<Published | null> {
    ctx.signal.throwIfAborted();
    if (ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(ref.id);
    if (!await assetCollectionEnabled(c, ref, true)) return null;
    const current = await this.current(c, ref);
    if (!current || current.binding.revision !== revision) return null;
    const [rows] = await c.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
      AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`, [job.id, ctx.workerId, ctx.fencingToken]);
    if (rows.length !== 1) return null;
    const [schedule] = await c.execute<RowDataPacket[]>('SELECT job_id FROM metric_schedule WHERE resource_key = ? AND revision = ? AND job_id = ?',
      [refKey(ref), revision, job.id]);
    return schedule.length === 1 ? current : null;
  }
  async begin(ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext, now: number, resource: Resource): Promise<ExecutionSnapshot | null> {
    return this.transaction(async c => {
      const published = await this.valid(c, ref, revision, job, ctx); if (!published) return null;
      const [caps] = await c.execute<RowDataPacket[]>('SELECT capabilities FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
      const [groups] = published.binding.group_id ? await c.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_groups WHERE id = ?', [published.binding.group_id]) : [[]];
      const effective = resolvePolicy(this.registry, published.binding, groups[0] ? decode<Group>(groups[0].payload) : null,
        resource, decode(caps[0].capabilities), new Date(now).toISOString());
      const plan = compilePlan(this.registry, effective);
      const [rows] = await c.execute<RowDataPacket[]>('SELECT states, job_id FROM metric_schedule WHERE resource_key = ?', [refKey(ref)]);
      if (rows[0]?.job_id !== job.id) return null;
      rule(now >= Date.parse(published.published_at) && (!published.application.reported_at || now >= Date.parse(published.application.reported_at)), 'SCHEDULE_APPLICATION_TIME');
      published.application = { status: 'applied', applied_revision: revision, reported_at: new Date(now).toISOString(), error_code: null };
      await c.execute('UPDATE metric_policy_bindings SET payload = ? WHERE resource_key = ?', [JSON.stringify(published), refKey(ref)]);
      const tickets = new Map<string, Ticket>();
      if (this.rolloutTicket === 'production') {
        // Snapshot source generations BEFORE remote IO; never borrow a new generation when a late result commits.
        const [sources] = await c.execute<RowDataPacket[]>(`SELECT * FROM metric_rollout
          WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE`, [ref.type, String(ref.id)]);
        for (const source of sources) {
          const pin = decode<{ id: string; version: string; digest: string }>(source.package_pin);
          if (source.source !== 'semantic' || source.read_mode !== 'semantic' || source.published_revision !== revision
            || pin.id !== published.binding.package.id || pin.version !== published.binding.package.version
            || pin.digest !== published.binding.package.digest) continue;
          tickets.set(source.series_hash, { source: 'semantic', generation: source.generation, revision });
          await c.execute('UPDATE metric_rollout SET applied_revision = published_revision WHERE series_hash = ?', [source.series_hash]);
        }
      }
      return { published: { ...published, resolved: effective }, plan, states: new Map(Object.entries(decode<Record<string, CounterState>>(rows[0].states))), tickets };
    });
  }
  async assertCurrent(ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext): Promise<void> {
    await this.transaction(async c => {
      const current = await this.current(c, ref);
      rule(current && current.binding.revision === revision, 'SCHEDULE_SUPERSEDED');
      rule(await this.valid(c, ref, revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
    });
  }
  async recordFailure(snapshot: ExecutionSnapshot, result: PackageResult, job: ClaimedJob, ctx: JobExecutionContext, now: number): Promise<void> {
    await this.transaction(async c => {
      rule(await this.valid(c, snapshot.plan.resource, snapshot.plan.revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      for (const attempt of result.attempts) await c.execute('INSERT INTO metric_attempts (id, payload, stored_at) VALUES (?, ?, ?)',
        [attempt.id, JSON.stringify(attempt), new Date(now)]);
      // Leave previous capabilities and counter baselines intact on a transient failure.
    });
  }
  async commit(snapshot: ExecutionSnapshot, result: PackageResult, job: ClaimedJob, ctx: JobExecutionContext, now: number): Promise<boolean> {
    const { plan, published } = snapshot;
    return this.transaction(async c => {
      const current = await this.valid(c, plan.resource, plan.revision, job, ctx); if (!current) return false;
      const [rows] = await c.execute<RowDataPacket[]>('SELECT job_id FROM metric_schedule WHERE resource_key = ? FOR UPDATE', [refKey(plan.resource)]);
      if (rows[0]?.job_id !== job.id) return false;
      const storage = new MysqlMetricStorage(c as unknown as Pool, () => new Date(now));
      const catalog = this.registry.catalog(published.binding.package);
      rule(result.observations.length <= published.resolved.settings.max_series_per_resource, 'SCHEDULE_SERIES_BUDGET');
      const release = this.registry.get(published.binding.package);
      validateBindings({ collections: [published.resolved.plan.binding], policies: [published.resolved.plan.policy],
        packages: [release.package], derived: release.derived, metrics: result.observations.map(({ observation: o }) => {
          const template = published.resolved.metric_templates.find(t => t.metric.id === o.metric.id && t.metric.semantic_version === o.metric.semantic_version);
          rule(template && template.enabled, 'SCHEDULE_OUTPUT_SOURCE');
          rule(o.source.collector_id === (template.source.kind === 'collector' ? template.source.collector_id : `derived:${template.source.derived_id}`), 'SCHEDULE_OUTPUT_SOURCE');
          return { id: o.source.metric_binding_id, collection_binding_id: published.resolved.plan.binding.id,
            resource_id: o.resource_id, metric: o.metric, dimensions: o.dimensions, enabled: true, source: template.source };
        }) }, catalog);
      const sourceValid = validSourceSnapshot(result.source_validation, plan.resource, result.observations.map(o => o.observation))
        && !result.source_validation?.checks.some(check => check.state !== 'passed');
      for (const { observation } of result.observations) {
        rule(observation.versions.config_revision === plan.revision && observation.resource_type === plan.resource.type
          && observation.resource_id === String(plan.resource.id), 'SCHEDULE_OUTPUT_IDENTITY');
        const definition = catalog.find(d => d.id === observation.metric.id && d.semantic_version === observation.metric.semantic_version)!;
        const ticket = this.rolloutTicket === 'production' ? snapshot.tickets?.get(seriesHash(observation)) : this.rolloutTicket;
        if (ticket && sourceValid) await new RolloutControl(this.pool, c, () => new Date(now)).publish(observation, definition, ticket);
        else await storage.write(observation, definition);
      }
      if (result.source_validation) await c.execute(`INSERT INTO metric_source_checks(resource_key,revision,payload,checked_at) VALUES(?,?,?,?)
        ON DUPLICATE KEY UPDATE payload=VALUES(payload),checked_at=VALUES(checked_at)`,
      [refKey(plan.resource),plan.revision,JSON.stringify(result.source_validation),new Date(now)]);
      // Raw evidence shares the same transaction and fences, but is never a formal publication.
      for (const raw of result.raw ?? []) {
        rule(raw.stage === 'raw' && raw.versions.config_revision === plan.revision
          && raw.resource_type === plan.resource.type && raw.resource_id === String(plan.resource.id), 'SCHEDULE_OUTPUT_IDENTITY');
        const output = result.observations.find(o => o.observation.lineage.some(input => input.stage === 'raw' && input.id === raw.id));
        rule(output, 'SCHEDULE_RAW_LINEAGE');
        const definition = catalog.find(d => d.id === raw.metric.id && d.semantic_version === raw.metric.semantic_version);
        rule(definition, 'SCHEDULE_OUTPUT_SOURCE');
        await storage.write(raw, definition);
      }
      for (const attempt of result.attempts) await c.execute('INSERT INTO metric_attempts (id, payload, stored_at) VALUES (?, ?, ?)',
        [attempt.id, JSON.stringify(attempt), new Date(now)]);
      rule(await this.valid(c, plan.resource, plan.revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      await c.execute('UPDATE metric_policy_bindings SET capabilities = ? WHERE resource_key = ?', [JSON.stringify(result.capabilities), refKey(plan.resource)]);
      await c.execute('UPDATE metric_schedule SET states = ?, job_id = NULL, last_end_ms = ?, next_due_ms = ? WHERE resource_key = ?',
        [JSON.stringify(Object.fromEntries(result.states)), now, now + plan.intervalMs, refKey(plan.resource)]);
      return true;
    });
  }
  // ---------------------------------------------------------- template rows
  //
  // A template binding executes the exact pending plan of its `templates-v1`
  // payload: one existing release at a time, restricted to the plan's own
  // collector and metric selection. It never synthesizes a single-package
  // `Published`, never compiles all package metrics and never rewrites the
  // binding payload (the accepted codec keeps `applied_revision <= base`, so the
  // pending plan is the current configuration this schedule executes).

  /** The current decoded template envelope, or null when the row is not one. */
  async currentTemplate(c: Pick<Pool, 'execute'> | PoolConnection, ref: Ref): Promise<DecodedTemplateBindingPayload | null> {
    const [rows] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    if (!rows[0]) return null;
    const decoded = decodeBindingPayload(rows[0].payload);
    return decoded.kind === 'template_pending' ? decoded : null;
  }

  /** Schedule one executable template plan; returns true only when a job was queued. */
  async enqueueTemplate(item: TemplateScheduleItem, now: number): Promise<boolean> {
    const { decoded } = item;
    const plan = decoded.pending.plan;
    const ref = decoded.binding.resource;
    const revision = decoded.binding.revision;
    const intervalMs = plan.settings.interval_ms;
    if (!plan.settings.enabled) return false;
    if (ref.type === 'instance') {
      try { await instanceAccessLifecycle.assertAvailable(ref.id); } catch { return false; }
    }
    const jitterMs = plan.releases[0]
      ? jitterFor(ref.type, ref.id, plan.releases[0].release.id, intervalMs)
      : parseInt(hash(`${ref.type}:${ref.id}`).slice(0, 8), 16) % Math.min(intervalMs, 10000);
    return this.transaction(async c => {
      const current = await this.currentTemplate(c, ref);
      if (!current || current.binding.revision !== revision) return false;
      if (!await assetCollectionEnabled(c, ref, true)) return false;
      const [rows] = await c.execute<RowDataPacket[]>('SELECT * FROM metric_schedule WHERE resource_key = ? FOR UPDATE', [refKey(ref)]);
      const row = rows[0];
      let next = row ? Number(row.next_due_ms) : now + jitterMs;
      let pending = (row?.job_id ?? null) as string | null;
      if (row && Number(row.revision) !== revision) {
        pending = null;
        next = row.last_end_ms === null ? now + jitterMs : Number(row.last_end_ms) + intervalMs;
      }
      if (pending) {
        const [jobs] = await c.execute<RowDataPacket[]>('SELECT state FROM workflow_jobs WHERE id = ?', [pending]);
        if (jobs.length && !['completed', 'dead_letter', 'cancelled'].includes(jobs[0].state)) return false;
        pending = null; next = Math.max(next, now + intervalMs);
      }
      await c.execute(`INSERT INTO metric_schedule (resource_key, revision, next_due_ms, states) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE states = IF(revision = VALUES(revision), states, VALUES(states)), revision = VALUES(revision), next_due_ms = VALUES(next_due_ms), job_id = ?`,
      [refKey(ref), revision, next, '{}', pending]);
      if (next > now) return false;
      if (row?.last_end_ms !== null && row?.last_end_ms !== undefined && !dueMetricIds([{ id: 'cycle', default_interval: intervalMs / 1000 }],
        new Map([['cycle', Number(row.last_end_ms)]]), now).length) return false;
      const id = randomUUID();
      const queue = new MysqlWorkflowStore(() => c as never);
      await queue.enqueue({ id, type: JOB_TYPE, schemaVersion: 1, payload: { resource: ref, revision: revision },
        idempotencyKey: `metric:${refKey(ref)}:${id}`, maxAttempts: 3, availableAt: new Date(now) });
      await c.execute('UPDATE metric_schedule SET job_id = ? WHERE resource_key = ?', [id, refKey(ref)]);
      return true;
    });
  }

  /** Fenced begin for one template revision; no payload write and no applied claim. */
  async beginTemplate(ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext, now: number): Promise<TemplateExecutionSnapshot | null> {
    return this.transaction(async c => {
      ctx.signal.throwIfAborted();
      if (ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(ref.id);
      if (!await assetCollectionEnabled(c, ref, true)) return null;
      const decoded = await this.currentTemplate(c, ref);
      if (!decoded || decoded.binding.revision !== revision) return null;
      const [jobs] = await c.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
        AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`,
      [job.id, ctx.workerId, ctx.fencingToken]);
      if (jobs.length !== 1) return null;
      const [schedule] = await c.execute<RowDataPacket[]>(
        'SELECT states, job_id FROM metric_schedule WHERE resource_key = ? AND revision = ? AND job_id = ?',
        [refKey(ref), revision, job.id]);
      if (schedule.length !== 1) return null;
      rule(now >= Date.parse(decoded.published_at), 'SCHEDULE_APPLICATION_TIME');
      const plan = decoded.pending.plan;
      const pins = new Set(plan.releases.map(entry => `${entry.release.id}@${entry.release.version}#${entry.release.digest}`));
      const [sources] = await c.execute<RowDataPacket[]>(`SELECT * FROM metric_rollout
        WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE`, [ref.type, String(ref.id)]);
      const tickets = new Map<string, Ticket>();
      for (const source of sources) {
        const pin = decode<{ id: string; version: string; digest: string }>(source.package_pin);
        if (source.source !== 'semantic' || source.read_mode !== 'semantic'
          || Number(source.published_revision) !== revision
          || !pins.has(`${pin.id}@${pin.version}#${pin.digest}`)) continue;
        tickets.set(String(source.series_hash), { source: 'semantic', generation: Number(source.generation), revision });
      }
      return { decoded, plan, tickets,
        states: new Map(Object.entries(decode<Record<string, CounterState>>(schedule[0].states))) };
    });
  }

  /**
   * The same live fence the accepted legacy path applies, for one template
   * revision: cancellation, resource lifecycle and collection switch, the exact
   * current binding revision, this job's running lease (owner, fencing token,
   * expiry) and the schedule row that still names it. A stale, expired,
   * cancelled, disabled or unbound execution must never write.
   */
  private async validTemplate(c: PoolConnection, ref: Ref, revision: number, job: ClaimedJob,
    ctx: JobExecutionContext): Promise<DecodedTemplateBindingPayload | null> {
    ctx.signal.throwIfAborted();
    if (ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(ref.id);
    if (!await assetCollectionEnabled(c, ref, true)) return null;
    const current = await this.currentTemplate(c, ref);
    if (!current || current.binding.revision !== revision) return null;
    const [jobs] = await c.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
      AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`,
    [job.id, ctx.workerId, ctx.fencingToken]);
    if (jobs.length !== 1) return null;
    const [schedule] = await c.execute<RowDataPacket[]>(
      'SELECT job_id FROM metric_schedule WHERE resource_key = ? AND revision = ? AND job_id = ?',
      [refKey(ref), revision, job.id]);
    return schedule.length === 1 ? current : null;
  }

  /**
   * The same live fence outside a write transaction, for every point where a
   * template execution is about to resolve a credential or issue another target
   * read. A stale job may lose its lease, its revision or its collection switch
   * after `beginTemplate`; the final commit refusing the result cannot take back
   * a request that was already sent.
   */
  async assertCurrentTemplate(ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext): Promise<void> {
    await this.transaction(async c => {
      const current = await this.currentTemplate(c, ref);
      rule(current && current.binding.revision === revision, 'SCHEDULE_SUPERSEDED');
      rule(await this.validTemplate(c, ref, revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
    });
  }

  /** Fenced commit of template observations: formal normalized write, attempts and cadence. */
  async commitTemplate(snapshot: TemplateExecutionSnapshot,
    results: Array<{ release: { id: string; version: string; digest: string }; result: PackageResult }>,
    job: ClaimedJob, ctx: JobExecutionContext, now: number): Promise<boolean> {
    const { decoded, plan } = snapshot;
    const ref = decoded.binding.resource, revision = decoded.binding.revision;
    return this.transaction(async c => {
      if (!await this.validTemplate(c, ref, revision, job, ctx)) return false;
      const [rows] = await c.execute<RowDataPacket[]>('SELECT job_id FROM metric_schedule WHERE resource_key = ? FOR UPDATE', [refKey(ref)]);
      if (rows[0]?.job_id !== job.id) return false;
      await this.writeTemplateResults(c, snapshot, results, now);
      // Re-checked after the last asynchronous work: anything written below is
      // rolled back if the lease, revision or switch changed during the call.
      rule(await this.validTemplate(c, ref, revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      await this.recordTemplateCapabilities(c, ref, results);
      const states = new Map(snapshot.states);
      for (const { result } of results) for (const [key, value] of result.states) states.set(key, value);
      await c.execute('UPDATE metric_schedule SET states = ?, job_id = NULL, last_end_ms = ?, next_due_ms = ? WHERE resource_key = ?',
        [JSON.stringify(Object.fromEntries(states)), now, now + plan.settings.interval_ms, refKey(ref)]);
      return true;
    });
  }

  /**
   * The one formal writer both cadences share: normalized observations, their raw
   * lineage, attempts and the revision's sample-id snapshot. It returns the exact
   * sample identities it wrote so a manual task can record its own samples in the
   * same transaction instead of reading another run's latest value later.
   */
  private async writeTemplateResults(c: PoolConnection, snapshot: TemplateExecutionSnapshot,
    results: Array<{ release: { id: string; version: string; digest: string }; result: PackageResult }>,
    now: number): Promise<{ samples: CollectSample[]; attempts: CollectAttempt[] }> {
    const { decoded } = snapshot;
    const ref = decoded.binding.resource, revision = decoded.binding.revision;
    const storage = new MysqlMetricStorage(c as unknown as Pool, () => new Date(now));
    const sampleIds: string[] = [];
    const samples: CollectSample[] = [];
    const attempts: CollectAttempt[] = [];
    for (const { release, result } of results) {
      const catalog = this.registry.catalog({ ...release });
      const releaseAttempts = result.attempts.map(attempt => ({
        id: String(attempt.id), collector_id: attempt.collector_id, status: String(attempt.status),
      }));
      attempts.push(...releaseAttempts);
      for (const { observation } of result.observations) {
        rule(observation.versions.config_revision === revision && observation.resource_type === ref.type
          && observation.resource_id === String(ref.id), 'SCHEDULE_OUTPUT_IDENTITY');
        rule(observation.versions.package_id === release.id && observation.versions.package_version === release.version,
          'SCHEDULE_OUTPUT_IDENTITY');
        const definition = catalog.find(d => d.id === observation.metric.id
          && d.semantic_version === observation.metric.semantic_version);
        rule(definition, 'SCHEDULE_OUTPUT_SOURCE');
        sampleIds.push(observation.id);
        samples.push({
          id: observation.id, metric: { ...observation.metric }, unit: observation.unit,
          value: observation.value, observed_at: observation.observed_at, quality: observation.quality,
          attempt_ids: releaseAttempts.map(attempt => attempt.id),
        });
        // A formalized series publishes through the accepted rollout control;
        // until then the normalized write is still the formal observation store.
        const ticket = snapshot.tickets.get(seriesHash(observation));
        if (ticket) await new RolloutControl(this.pool, c, () => new Date(now)).publish(observation, definition!, ticket);
        else await storage.write(observation, definition!);
      }
      // Raw evidence shares the same fences and transaction; it is never a
      // formal publication but the normalized lineage must resolve to it.
      for (const raw of result.raw ?? []) {
        rule(raw.stage === 'raw' && raw.versions.config_revision === revision
          && raw.resource_type === ref.type && raw.resource_id === String(ref.id), 'SCHEDULE_OUTPUT_IDENTITY');
        const output = result.observations.find(entry =>
          entry.observation.lineage.some(input => input.stage === 'raw' && input.id === raw.id));
        rule(output, 'SCHEDULE_RAW_LINEAGE');
        const definition = catalog.find(d => d.id === raw.metric.id
          && d.semantic_version === raw.metric.semantic_version);
        rule(definition, 'SCHEDULE_OUTPUT_SOURCE');
        await storage.write(raw, definition!);
      }
      for (const attempt of result.attempts) {
        await c.execute('INSERT INTO metric_attempts (id, payload, stored_at) VALUES (?, ?, ?)',
          [attempt.id, JSON.stringify(attempt), new Date(now)]);
      }
    }
    if (sampleIds.length) {
      await c.execute(`INSERT INTO metric_source_checks(resource_key,revision,payload,checked_at) VALUES(?,?,?,?)
        ON DUPLICATE KEY UPDATE payload=VALUES(payload),checked_at=VALUES(checked_at)`,
      [refKey(ref), revision, JSON.stringify({ sample_ids: sampleIds }), new Date(now)]);
    }
    // Application is a successful normal writer outcome, never an API label.
    // Require every selected metric, successful reads and usable values before first promotion.
    const observations = results.flatMap(entry => entry.result.observations.map(o => o.observation));
    const required = snapshot.plan.releases.flatMap(release => release.steps.flatMap(step => step.items));
    const complete = required.length > 0 && required.every(item => observations.some(o =>
      o.metric.id === item.canonical_metric.id && o.metric.semantic_version === item.canonical_metric.semantic_version
      && o.value !== null && ['good','partial'].includes(o.quality.status)))
      && attempts.length > 0 && attempts.every(a => a.status === 'succeeded');
    let live = await this.currentTemplate(c, ref);
    rule(live && live.binding.revision === revision, 'SCHEDULE_STALE_EXECUTION');
    if (complete && live.application.applied_revision !== revision) {
      const appliedPayload = encodeTemplateAppliedPayload(live, {
        sample_ids:sampleIds,attempt_ids:attempts.map(a => a.id),at:new Date(now).toISOString(),
      });
      await c.execute('UPDATE metric_policy_bindings SET payload=? WHERE resource_key=?', [appliedPayload,refKey(ref)]);
      live = decodeBindingPayload(appliedPayload) as DecodedTemplateBindingPayload;
    }
    if (live.application.status === 'applied' && live.application.applied_revision === revision) {
      await evaluateTemplateSamples(c,live,observations,now);
    }
    return { samples, attempts };
  }

  /** A template run is capability evidence for the exact releases it read. */
  private async recordTemplateCapabilities(c: PoolConnection, ref: Ref,
    results: Array<{ result: PackageResult }>): Promise<void> {
    const capabilities = results.flatMap(({ result }) => result.capabilities ?? []);
    if (capabilities.length) {
      await c.execute('UPDATE metric_policy_bindings SET capabilities = ? WHERE resource_key = ?',
        [JSON.stringify(capabilities), refKey(ref)]);
    }
  }

  async recordTemplateFailure(snapshot: TemplateExecutionSnapshot,
    results: Array<{ release: { id: string; version: string; digest: string }; result: PackageResult }>,
    job: ClaimedJob, ctx: JobExecutionContext, now: number): Promise<void> {
    const ref = snapshot.decoded.binding.resource, revision = snapshot.decoded.binding.revision;
    await this.transaction(async c => {
      // Failure rows are an execution side effect too: only a live lease for the
      // current revision may append them.
      rule(await this.validTemplate(c, ref, revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      for (const { result } of results) {
        for (const attempt of result.attempts) {
          await c.execute('INSERT INTO metric_attempts (id, payload, stored_at) VALUES (?, ?, ?)',
            [attempt.id, JSON.stringify(attempt), new Date(now)]);
        }
      }
    });
  }

  async event(ref: Ref, revision: number, jobId: string, code: string, uncertain: boolean, duration: number, reads: number): Promise<void> {
    await this.pool.execute(`INSERT INTO metric_schedule_events (resource_key, job_id, revision, code, uncertain, duration_ms, logical_reads)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [refKey(ref), jobId, revision, code, uncertain, Math.max(0, duration), reads]);
  }

  // -------------------------------------------------------- manual collect
  //
  // A manual collection is a distinct durable task in the same workflow queue.
  // It executes the binding's exact pending plan and commits through the same
  // formal writer, but its fence is this task's own row plus the job lease: it
  // never borrows (and never overwrites) `metric_schedule.job_id`.

  /** Read-committed: a grant or binding committed after the transaction opened must be seen. */
  private async collectTransaction<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    try {
      await c.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await c.beginTransaction();
      const [lock] = await c.query<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
      rule(lock.length === 1, 'SCHEDULE_STORE_UNAVAILABLE');
      const result = await fn(c); await c.commit(); return result;
    } catch (e) { await c.rollback().catch(() => undefined); throw e; } finally { c.release(); }
  }

  private collectTask(row: RowDataPacket, jobState: string | null, jobExpired = false): CollectTask {
    const stored = String(row.state) as CollectTaskState;
    const terminal = stored === 'completed' || stored === 'failed' || stored === 'cancelled' || stored === 'unknown';
    // A job that completed without a journal row proves nothing about samples;
    // only the terminal journal state may claim a result.
    const state: CollectTaskState = terminal ? stored
      : jobState === null ? stored
      : jobState === 'queued' || jobState === 'retry' ? 'accepted'
      : jobState === 'running' ? (jobExpired ? 'unknown' : 'running')
      : jobState === 'completed' ? 'unknown'
      : jobState === 'dead_letter' ? 'failed'
      : jobState === 'cancelled' ? 'cancelled' : stored;
    const decodeJson = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;
    const [type, id] = String(row.resource_key).split(':');
    return {
      id: String(row.id), resource: RefSchema.parse({ type, id: Number(id) }),
      caller_key: String(row.caller_key), revision: Number(row.revision),
      resolution_identity: String(row.resolution_identity), job_id: String(row.job_id), state,
      outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome) as CollectOutcome,
      error_code: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
      samples: Array.isArray(row.samples) ? row.samples as CollectSample[]
        : row.samples ? decodeJson(row.samples) as CollectSample[] : [],
      attempts: Array.isArray(row.attempts) ? row.attempts as CollectAttempt[]
        : row.attempts ? decodeJson(row.attempts) as CollectAttempt[] : [],
      created_at: new Date(row.created_at).toISOString(),
      started_at: row.started_at === null ? null : new Date(row.started_at).toISOString(),
      finished_at: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
      job_state: jobState,
    };
  }

  /** One task row + the workflow state that may still be in flight. */
  private async readCollectTask(c: Pick<Pool, 'execute'> | PoolConnection, where: string, values: any[],
    forUpdate = false): Promise<CollectTask | null> {
    const [rows] = await c.execute<RowDataPacket[]>(
      `SELECT r.*, j.state AS job_state, j.lease_expires_at AS job_lease_expires_at
         FROM metric_collect_requests r LEFT JOIN workflow_jobs j ON BINARY j.id = BINARY r.job_id
        WHERE ${where}${forUpdate ? ' FOR UPDATE' : ''}`, values);
    const row = rows[0];
    if (!row) return null;
    const jobState = row.job_state === null || row.job_state === undefined ? null : String(row.job_state);
    const lease = row.job_lease_expires_at === null || row.job_lease_expires_at === undefined
      ? null : new Date(row.job_lease_expires_at).getTime();
    const expired = lease !== null && lease <= Date.now();
    return this.collectTask(row, jobState, Boolean(expired));
  }

  /**
   * Persist one user intent and enqueue exactly one job in the same transaction.
   * The same key from the same principal with the identical intent replays that
   * task; any other reuse is a conflict, never a second job. `authorize` re-reads
   * the live grant on the writer's own connection after the policy lock.
   */
  async admitCollectNow(input: CollectAdmissionInput,
    authorize: (c: { execute(sql: string, values?: any[]): Promise<unknown> }) => Promise<void>): Promise<CollectAdmissionResult> {
    const now = Date.now();
    return this.collectTransaction(async c => {
      const decoded = await this.currentTemplate(c, input.ref);
      rule(decoded !== null, 'COLLECT_BINDING_NOT_TEMPLATE', 409);
      const plan = decoded!.pending.plan;
      rule(plan.executable, 'COLLECT_PLAN_NOT_EXECUTABLE', 409);
      rule(plan.settings.enabled, 'COLLECT_BINDING_DISABLED', 409);
      const revision = decoded!.binding.revision;
      rule(input.expectedRevision === revision, 'COLLECT_REVISION_CONFLICT', 409);
      rule(Date.parse(decoded!.published_at) <= now, 'COLLECT_NOT_PUBLISHED', 409);
      if (input.ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(input.ref.id);
      rule(await assetCollectionEnabled(c, input.ref, true), 'ASSET_COLLECTION_DISABLED', 409);
      const digest = await collectIntentDigest(c, input.ref, decoded!);

      const existing = await this.readCollectTask(c, 'r.resource_key = ? AND r.caller_key = ?',
        [refKey(input.ref), input.callerKey], true);
      if (existing) {
        const [rows] = await c.execute<RowDataPacket[]>(
          'SELECT actor_id, intent_digest FROM metric_collect_requests WHERE resource_key = ? AND caller_key = ?',
          [refKey(input.ref), input.callerKey]);
        rule(rows[0] && Number(rows[0].actor_id) === input.actorId
          && String(rows[0].intent_digest) === digest, 'COLLECT_INTENT_CONFLICT', 409);
        await authorize(c);
        return { created: false, task: existing };
      }

      await authorize(c);
      const id = randomUUID(), jobId = randomUUID();
      // The unique (resource_key, caller_key) insert is the admission fence: a
      // concurrent same-key request blocks here and then replays, so exactly one
      // job is ever enqueued for one key. No second job is created below.
      const [insert] = await c.execute<any>(
        `INSERT INTO metric_collect_requests
        (id, resource_key, caller_key, actor_id, session_version, revision, resolution_identity, intent_digest, job_id, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted') ON DUPLICATE KEY UPDATE id = id`,
      [id, refKey(input.ref), input.callerKey, input.actorId, input.sessionVersion, revision,
        decoded!.pending.resolution_identity, digest, jobId]);
      if (Number(insert.affectedRows) === 0) {
        // Another request with this exact key committed while this one waited.
        const [rows] = await c.execute<RowDataPacket[]>(
          'SELECT actor_id, intent_digest FROM metric_collect_requests WHERE resource_key = ? AND caller_key = ?',
          [refKey(input.ref), input.callerKey]);
        rule(rows[0] && Number(rows[0].actor_id) === input.actorId
          && String(rows[0].intent_digest) === digest, 'COLLECT_INTENT_CONFLICT', 409);
        await authorize(c);
        const replay = await this.readCollectTask(c, 'r.resource_key = ? AND r.caller_key = ?',
          [refKey(input.ref), input.callerKey]);
        rule(replay, 'COLLECT_TASK_UNAVAILABLE', 503);
        return { created: false, task: replay! };
      }
      const queue = new MysqlWorkflowStore(() => c as never);
      await queue.enqueue({ id: jobId, type: COLLECT_NOW_JOB_TYPE, schemaVersion: 1,
        payload: { resource: input.ref, revision, request_id: id },
        idempotencyKey: `metric-collect:${refKey(input.ref)}:${id}`, maxAttempts: 3, availableAt: new Date(now) });
      const task = await this.readCollectTask(c, 'r.id = ?', [id]);
      rule(task, 'COLLECT_TASK_UNAVAILABLE', 503);
      return { created: true, task: task! };
    });
  }

  /** The task for one caller key, scoped to the principal that asked for it. */
  async collectTaskFor(ref: Ref, callerKey: string, actorId: number): Promise<CollectTask | null> {
    const task = await this.readCollectTask(this.pool, 'r.resource_key = ? AND r.caller_key = ?', [refKey(ref), callerKey]);
    if (!task) return null;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT actor_id FROM metric_collect_requests WHERE resource_key = ? AND caller_key = ?', [refKey(ref), callerKey]);
    return Number(rows[0]?.actor_id) === actorId ? task : null;
  }

  async collectTaskById(requestId: string): Promise<CollectTask | null> {
    return this.readCollectTask(this.pool, 'r.id = ?', [requestId]);
  }

  /** The task plus the persisted principal the worker must re-read live. */
  async collectExecutionContext(requestId: string): Promise<{ task: CollectTask; actorId: number; sessionVersion: number } | null> {
    const task = await this.collectTaskById(requestId);
    if (!task) return null;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT actor_id, session_version FROM metric_collect_requests WHERE id = ?', [requestId]);
    if (!rows[0]) return null;
    return { task, actorId: Number(rows[0].actor_id), sessionVersion: Number(rows[0].session_version) };
  }

  /** Fenced begin for one manual task; never claims an applied binding or schedule row. */
  async beginCollectNow(ref: Ref, revision: number, requestId: string, job: ClaimedJob,
    ctx: JobExecutionContext, now: number,
    authorizeOn: (c: { execute(sql: string, values?: any[]): Promise<unknown> }) => Promise<void>): Promise<TemplateExecutionSnapshot | null> {
    return this.collectTransaction(async c => {
      ctx.signal.throwIfAborted();
      const decoded = await this.currentTemplate(c, ref);
      if (!decoded || decoded.binding.revision !== revision) return null;
      rule(await this.validCollectNow(c, ref, revision, requestId, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      await authorizeOn(c);
      if (ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(ref.id);
      if (!await assetCollectionEnabled(c, ref, true)) return null;
      const task = await this.readCollectTask(c, 'r.id = ?', [requestId], true);
      if (!task || task.job_id !== job.id || !['accepted', 'running'].includes(task.state)) return null;
      const [jobs] = await c.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
        AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`,
      [job.id, ctx.workerId, ctx.fencingToken]);
      if (jobs.length !== 1) return null;
      rule(now >= Date.parse(decoded.published_at), 'SCHEDULE_APPLICATION_TIME');
      await c.execute(`UPDATE metric_collect_requests SET state = 'running',
        started_at = COALESCE(started_at, NOW(6)), updated_at = NOW(6) WHERE id = ?`, [requestId]);
      const plan = decoded.pending.plan;
      const pins = new Set(plan.releases.map(entry => `${entry.release.id}@${entry.release.version}#${entry.release.digest}`));
      const [sources] = await c.execute<RowDataPacket[]>(`SELECT * FROM metric_rollout
        WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE`, [ref.type, String(ref.id)]);
      const tickets = new Map<string, Ticket>();
      for (const source of sources) {
        const pin = decode<{ id: string; version: string; digest: string }>(source.package_pin);
        if (source.source !== 'semantic' || source.read_mode !== 'semantic'
          || Number(source.published_revision) !== revision
          || !pins.has(`${pin.id}@${pin.version}#${pin.digest}`)) continue;
        tickets.set(String(source.series_hash), { source: 'semantic', generation: Number(source.generation), revision });
        await c.execute('UPDATE metric_rollout SET applied_revision = published_revision WHERE series_hash = ?', [source.series_hash]);
      }
      // Counter baselines are not schedule state ownership: read the current
      // cadence's snapshot, never force it to this job.
      const [schedule] = await c.execute<RowDataPacket[]>(
        'SELECT states FROM metric_schedule WHERE resource_key = ? AND revision = ?', [refKey(ref), revision]);
      return { decoded, plan, tickets,
        states: new Map(Object.entries(decode<Record<string, CounterState>>(schedule[0]?.states ?? '{}'))) };
    });
  }

  /** The live fence for a manual task: task/job identity plus the exact binding revision. */
  private async validCollectNow(c: PoolConnection, ref: Ref, revision: number, requestId: string,
    job: ClaimedJob, ctx: JobExecutionContext): Promise<boolean> {
    ctx.signal.throwIfAborted();
    if (ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(ref.id);
    if (!await assetCollectionEnabled(c, ref, true)) return false;
    const current = await this.currentTemplate(c, ref);
    if (!current || current.binding.revision !== revision) return false;
    const [jobs] = await c.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
      AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`,
    [job.id, ctx.workerId, ctx.fencingToken]);
    if (jobs.length !== 1) return false;
    const [rows] = await c.execute<RowDataPacket[]>(
      "SELECT id, intent_digest FROM metric_collect_requests WHERE id = ? AND job_id = ? AND state IN ('accepted','running') FOR UPDATE",
      [requestId, job.id]);
    return rows.length === 1 && String(rows[0].intent_digest) === await collectIntentDigest(c, ref, current);
  }

  async assertCollectNow(ref: Ref, revision: number, requestId: string, job: ClaimedJob,
    ctx: JobExecutionContext,
    authorizeOn: (c: { execute(sql: string, values?: any[]): Promise<unknown> }) => Promise<void>): Promise<void> {
    await this.collectTransaction(async c => {
      const current = await this.currentTemplate(c, ref);
      rule(current && current.binding.revision === revision, 'SCHEDULE_SUPERSEDED');
      rule(await this.validCollectNow(c, ref, revision, requestId, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      await authorizeOn(c);
      ctx.signal.throwIfAborted();
    });
  }

  /** Fenced commit: the shared formal writer plus this task's own sample identity row. */
  async commitCollectNow(ref: Ref, revision: number, requestId: string, snapshot: TemplateExecutionSnapshot,
    results: Array<{ release: { id: string; version: string; digest: string }; result: PackageResult }>,
    job: ClaimedJob, ctx: JobExecutionContext, now: number,
    authorizeOn?: (c: { execute(sql: string, values?: any[]): Promise<unknown> }) => Promise<void>): Promise<boolean> {
    return this.collectTransaction(async c => {
      if (!await this.validCollectNow(c, ref, revision, requestId, job, ctx)) return false;
      const written = await this.writeTemplateResults(c, snapshot, results, now);
      // A grant revoked while the writer waited must not persist a result.
      await authorizeOn?.(c);
      rule(await this.validCollectNow(c, ref, revision, requestId, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      await this.recordTemplateCapabilities(c, ref, results);
      const outcome: CollectOutcome = written.samples.length ? 'sampled' : 'no_samples';
      await c.execute(`UPDATE metric_collect_requests SET state = 'completed', outcome = ?, error_code = NULL,
        samples = ?, attempts = ?, finished_at = NOW(6), updated_at = NOW(6) WHERE id = ?`,
      [outcome, JSON.stringify(written.samples), JSON.stringify(written.attempts), requestId]);
      // Counter continuity only: never the schedule's job id, last end or cadence.
      const states = new Map(snapshot.states);
      for (const { result } of results) for (const [key, value] of result.states) states.set(key, value);
      await c.execute('UPDATE metric_schedule SET states = ? WHERE resource_key = ? AND revision = ?',
        [JSON.stringify(Object.fromEntries(states)), refKey(ref), revision]);
      return true;
    });
  }

  /**
   * Record why a manual run ended without a committed result. Guarded on the
   * task/job/state so a late worker cannot overwrite a terminal journal row.
   * Attempt rows are persisted here so a failed task keeps its exact evidence.
   */
  async failCollectNow(ref: Ref, revision: number, requestId: string, job: ClaimedJob, ctx: JobExecutionContext,
    state: Exclude<CollectTaskState, 'accepted' | 'running' | 'completed'>,
    code: string, attempts: CollectAttempt[], now: number,
    authorizeOn: (c: { execute(sql: string, values?: any[]): Promise<unknown> }) => Promise<void>): Promise<void> {
    await this.collectTransaction(async c => {
      // Only a still-authorized, fenced job may persist attempt data. Keep a
      // diagnostic unknown journal when its authority or lease has changed.
      let authorized = false;
      try {
        authorized = await this.validCollectNow(c, ref, revision, requestId, job, ctx);
        if (authorized) await authorizeOn(c);
      } catch { authorized = false; }
      if (!authorized) { state = 'unknown'; attempts = []; }
      if (attempts.length) {
        const [rows] = await c.execute<RowDataPacket[]>(
          "SELECT id FROM metric_collect_requests WHERE id = ? AND job_id = ? AND state IN ('accepted','running') FOR UPDATE",
          [requestId, job.id]);
        if (rows.length !== 1) return;
        for (const attempt of attempts) {
          await c.execute('INSERT IGNORE INTO metric_attempts (id, payload, stored_at) VALUES (?, ?, ?)',
            [attempt.id, JSON.stringify(attempt), new Date(now)]);
        }
      }
      const outcome: CollectOutcome = state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : 'unknown';
      await c.execute(`UPDATE metric_collect_requests SET state = ?, outcome = ?, error_code = ?,
        attempts = JSON_MERGE_PRESERVE(COALESCE(attempts, JSON_ARRAY()), ?), finished_at = NOW(6), updated_at = NOW(6)
        WHERE id = ? AND job_id = ? AND state IN ('accepted','running')`,
      [state, outcome, code.slice(0, 64), JSON.stringify(attempts), requestId, job.id]);
    });
  }
}
