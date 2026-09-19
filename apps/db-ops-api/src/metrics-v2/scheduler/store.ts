import { validateBindings, type Resource } from '../../contracts/metrics-v2/index.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { dueMetricIds } from '../../collection-scheduler.js';
import { MysqlWorkflowStore, type ClaimedJob, type JobExecutionContext } from '../../workflows/worker-runtime.js';
import { MysqlMetricStorage } from '../storage.js';
import { RolloutControl, type Ticket } from '../rollout/control.js';
import type { PackageRegistry } from '../packages/model.js';
import type { PackageResult } from '../packages/runner.js';
import type { CounterState } from '../state.js';
import { type Published, type Ref, type Group, refKey, rule } from '../policy/model.js';
import { resolvePolicy } from '../policy/resolver.js';
import { compilePlan, hash, type CollectorPlan } from './compiler.js';

export const JOB_TYPE = 'metrics.collect';
export const GLOBAL_CONCURRENCY = 4;
const decode = <T>(v: T | string): T => typeof v === 'string' ? JSON.parse(v) : v;
export interface ExecutionSnapshot { published: Published; plan: CollectorPlan; states: Map<string, CounterState> }
export interface Reservation { connection: PoolConnection; release(): Promise<void> }

/** Short transactions share the policy publication lock. Never hold a transaction during remote IO. */
export class MysqlScheduleStore {
  constructor(readonly pool: Pool, private readonly registry: PackageRegistry,
    private readonly rolloutTicket?: Ticket) {}
  async list(): Promise<Published[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_policy_bindings ORDER BY resource_key');
    return rows.map(r => decode<Published>(r.payload));
  }
  private async transaction<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [lock] = await c.query<RowDataPacket[]>('SELECT id FROM metric_v2_policy_lock WHERE id = 1 FOR UPDATE');
      rule(lock.length === 1, 'SCHEDULE_STORE_UNAVAILABLE');
      const result = await fn(c); await c.commit(); return result;
    } catch (e) { await c.rollback().catch(() => undefined); throw e; } finally { c.release(); }
  }
  async current(c: Pick<Pool, 'execute'> | PoolConnection, ref: Ref): Promise<Published | null> {
    const [rows] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_v2_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    return rows[0] ? decode<Published>(rows[0].payload) : null;
  }
  async enqueue(published: Published, now: number): Promise<boolean> {
    // Compile before any write; corrupt configuration never queues a job or advances applied revision.
    const plan = compilePlan(this.registry, published.resolved), ref = published.binding.resource;
    rule(plan.revision === published.binding.revision && refKey(ref) === refKey(plan.resource), 'PLAN_IDENTITY');
    return this.transaction(async c => {
      const current = await this.current(c, ref);
      if (!current || current.binding.revision !== plan.revision) return false;
      const [rows] = await c.execute<RowDataPacket[]>('SELECT * FROM metric_v2_schedule WHERE resource_key = ? FOR UPDATE', [refKey(ref)]);
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
      await c.execute(`INSERT INTO metric_v2_schedule (resource_key, revision, next_due_ms, states) VALUES (?, ?, ?, ?)
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
      await c.execute('UPDATE metric_v2_schedule SET job_id = ? WHERE resource_key = ?', [id, refKey(ref)]);
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
      if (!await acquire(`mv2:${prefix}:resource:${hash(refKey(ref)).slice(0, 24)}`)) { await release(); return null; }
      for (let i = 0; i < GLOBAL_CONCURRENCY; i++) if (await acquire(`mv2:${prefix}:slot:${i}`)) return { connection: c, release };
      await release(); return null;
    } catch (e) { await release(); throw e; }
  }
  private async valid(c: PoolConnection, ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext): Promise<Published | null> {
    ctx.signal.throwIfAborted();
    const current = await this.current(c, ref);
    if (!current || current.binding.revision !== revision) return null;
    const [rows] = await c.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
      AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`, [job.id, ctx.workerId, ctx.fencingToken]);
    if (rows.length !== 1) return null;
    const [schedule] = await c.execute<RowDataPacket[]>('SELECT job_id FROM metric_v2_schedule WHERE resource_key = ? AND revision = ? AND job_id = ?',
      [refKey(ref), revision, job.id]);
    return schedule.length === 1 ? current : null;
  }
  async begin(ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext, now: number, resource: Resource): Promise<ExecutionSnapshot | null> {
    return this.transaction(async c => {
      const published = await this.valid(c, ref, revision, job, ctx); if (!published) return null;
      const [caps] = await c.execute<RowDataPacket[]>('SELECT capabilities FROM metric_v2_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
      const [groups] = published.binding.group_id ? await c.execute<RowDataPacket[]>('SELECT payload FROM metric_v2_policy_groups WHERE id = ?', [published.binding.group_id]) : [[]];
      const effective = resolvePolicy(this.registry, published.binding, groups[0] ? decode<Group>(groups[0].payload) : null,
        resource, decode(caps[0].capabilities), new Date(now).toISOString());
      const plan = compilePlan(this.registry, effective);
      const [rows] = await c.execute<RowDataPacket[]>('SELECT states, job_id FROM metric_v2_schedule WHERE resource_key = ?', [refKey(ref)]);
      if (rows[0]?.job_id !== job.id) return null;
      rule(now >= Date.parse(published.published_at) && (!published.application.reported_at || now >= Date.parse(published.application.reported_at)), 'SCHEDULE_APPLICATION_TIME');
      published.application = { status: 'applied', applied_revision: revision, reported_at: new Date(now).toISOString(), error_code: null };
      await c.execute('UPDATE metric_v2_policy_bindings SET payload = ? WHERE resource_key = ?', [JSON.stringify(published), refKey(ref)]);
      return { published: { ...published, resolved: effective }, plan, states: new Map(Object.entries(decode<Record<string, CounterState>>(rows[0].states))) };
    });
  }
  async assertCurrent(ref: Ref, revision: number, job: ClaimedJob, ctx: JobExecutionContext): Promise<void> {
    const valid = await this.transaction(c => this.valid(c, ref, revision, job, ctx));
    rule(valid, 'SCHEDULE_STALE_EXECUTION');
  }
  async recordFailure(snapshot: ExecutionSnapshot, result: PackageResult, job: ClaimedJob, ctx: JobExecutionContext, now: number): Promise<void> {
    await this.transaction(async c => {
      rule(await this.valid(c, snapshot.plan.resource, snapshot.plan.revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      for (const attempt of result.attempts) await c.execute('INSERT INTO metric_v2_attempts (id, payload, stored_at) VALUES (?, ?, ?)',
        [attempt.id, JSON.stringify(attempt), new Date(now)]);
      // Leave previous capabilities and counter baselines intact on a transient failure.
    });
  }
  async commit(snapshot: ExecutionSnapshot, result: PackageResult, job: ClaimedJob, ctx: JobExecutionContext, now: number): Promise<boolean> {
    const { plan, published } = snapshot;
    return this.transaction(async c => {
      const current = await this.valid(c, plan.resource, plan.revision, job, ctx); if (!current) return false;
      const [rows] = await c.execute<RowDataPacket[]>('SELECT job_id FROM metric_v2_schedule WHERE resource_key = ? FOR UPDATE', [refKey(plan.resource)]);
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
      for (const { observation } of result.observations) {
        rule(observation.versions.config_revision === plan.revision && observation.resource_type === plan.resource.type
          && observation.resource_id === String(plan.resource.id), 'SCHEDULE_OUTPUT_IDENTITY');
        const definition = catalog.find(d => d.id === observation.metric.id && d.semantic_version === observation.metric.semantic_version)!;
        if (this.rolloutTicket) await new RolloutControl(this.pool, c, () => new Date(now)).publish(observation, definition, this.rolloutTicket);
        else await storage.write(observation, definition);
      }
      for (const attempt of result.attempts) await c.execute('INSERT INTO metric_v2_attempts (id, payload, stored_at) VALUES (?, ?, ?)',
        [attempt.id, JSON.stringify(attempt), new Date(now)]);
      rule(await this.valid(c, plan.resource, plan.revision, job, ctx), 'SCHEDULE_STALE_EXECUTION');
      await c.execute('UPDATE metric_v2_policy_bindings SET capabilities = ? WHERE resource_key = ?', [JSON.stringify(result.capabilities), refKey(plan.resource)]);
      await c.execute('UPDATE metric_v2_schedule SET states = ?, job_id = NULL, last_end_ms = ?, next_due_ms = ? WHERE resource_key = ?',
        [JSON.stringify(Object.fromEntries(result.states)), now, now + plan.intervalMs, refKey(plan.resource)]);
      return true;
    });
  }
  async event(ref: Ref, revision: number, jobId: string, code: string, uncertain: boolean, duration: number, reads: number): Promise<void> {
    await this.pool.execute(`INSERT INTO metric_v2_schedule_events (resource_key, job_id, revision, code, uncertain, duration_ms, logical_reads)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [refKey(ref), jobId, revision, code, uncertain, Math.max(0, duration), reads]);
  }
}
