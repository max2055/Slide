import { SourceSnapshotCapture } from '../rollout/source-shadow.js';
import { discoveryBudget } from '../templates/discovery-store.js';
import { platformLogs } from '../../platform/structured-log-evidence-adapter.js';
import { instanceAccessLifecycle } from '../../resources/instance-access-lifecycle.js';
import { z } from 'zod';
import type { Resource } from '../../contracts/metrics/index.js';
import type { JobRegistry } from '../../workflows/job-registry.js';
import { runPackage, type PackageExecution } from '../packages/runner.js';
import type { PackageRegistry } from '../packages/model.js';
import { type Ref, RefSchema, refKey, rule, PolicyError } from '../policy/model.js';
import { bindingReadCode, isTemplateBindingUnsupported } from '../bindings/package-reader.js';
import { compilePlan } from './compiler.js';
import { itemIntervals } from '../bindings/plan.js';
import { COLLECT_NOW_JOB_TYPE, JOB_TYPE, MysqlScheduleStore, type CollectAttempt, type TemplateExecutionSnapshot } from './store.js';
import type { ClaimedJob, JobExecutionContext } from '../../workflows/worker-runtime.js';

// These driver errors describe one row's data, not loss of the shared store.
const resourceSqlFailures = new Set(['ER_DATA_TOO_LONG', 'ER_TRUNCATED_WRONG_VALUE', 'ER_BAD_NULL_ERROR',
  'ER_INVALID_JSON_TEXT', 'ER_CHECK_CONSTRAINT_VIOLATED', 'ER_DUP_ENTRY', 'ER_NO_REFERENCED_ROW_2']);

/** SQL/transport/pool and shared lock failures belong to the whole tick. Never
 * turn an unavailable control-plane database into a successful empty scan. */
function globalSchedulingFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; errno?: unknown; sqlState?: unknown; fatal?: unknown };
  if (typeof failure.code === 'string' && resourceSqlFailures.has(failure.code)) return false;
  if (typeof failure.errno === 'number' || typeof failure.sqlState === 'string' || failure.fatal === true) return true;
  if (typeof failure.code === 'string' && /^(ER_|ECONN|EHOST|ENET|EPIPE|ETIMEDOUT|PROTOCOL_)/.test(failure.code)) return true;
  if (error instanceof PolicyError && ['SCHEDULE_STORE_UNAVAILABLE', 'SOURCE_POLICY_LOCK_UNAVAILABLE'].includes(error.code)) return true;
  // mysql2 pool exhaustion/closure errors have no driver code.
  return error instanceof Error && /^(Pool is closed\.?|No connections available\.?|Queue limit reached\.?)$/.test(error.message);
}

function schedulingFailureCode(error: unknown): string {
  const binding = bindingReadCode(error);
  if (binding) return binding;
  if (error instanceof PolicyError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'METRIC_RESOURCE_CONFIG_INVALID';
  if (error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && resourceSqlFailures.has(error.code)) return error.code;
  // Arbitrary exception text can include SQL, payloads or credentials.
  return 'METRIC_RESOURCE_SCHEDULE_FAILED';
}

const Payload = z.strictObject({ resource: RefSchema, revision: z.number().int().positive() });
const CollectNowPayload = Payload.extend({ request_id: z.string().uuid() });
export interface CollectorAccess {
  /** Must authorize this exact resource and resolve only its own credential reference. */
  resolve(ref: Ref): Promise<Pick<PackageExecution, 'resolve' | 'evidence'> & {
    credential_ref: string; resource: Resource; assertCurrent?: () => Promise<void>;
  }>;
}
/** A persisted task's principal, re-read live before every read and at commit. */
export interface CollectNowAuthorizer {
  authorize(actorId: number, sessionVersion: number, ref: Ref): Promise<void>;
  authorizeOn(executor: { execute(sql: string, values?: unknown[]): Promise<unknown> },
    actorId: number, sessionVersion: number, ref: Ref): Promise<void>;
}
type PackageResults = Array<{ release: { id: string; version: string; digest: string }; result: import('../packages/runner.js').PackageResult }>;
/**
 * The one execution core, fenced by whichever durable task asked for it. The
 * periodic schedule and a manual task differ only in their fence and their
 * post-commit bookkeeping; they share the same plan, access, runner and writer.
 */
export interface TemplateRunFence {
  /** `return` keeps the accepted cadence semantics; a task must report why it stopped. */
  onMissingBinding(): 'return' | 'throw';
  assertCurrent(snapshot?: TemplateExecutionSnapshot): Promise<void>;
  begin(): Promise<TemplateExecutionSnapshot | null>;
  commit(snapshot: TemplateExecutionSnapshot, results: PackageResults): Promise<boolean>;
  recordFailure(snapshot: TemplateExecutionSnapshot, results: PackageResults): Promise<void>;
  /** Terminal diagnostic for a task; the periodic fence records its own event only. */
  fail(code: string, uncertain: boolean, attempts: CollectAttempt[]): Promise<void>;
  afterCommit?(): Promise<void>;
}
/** Host calls tick on its existing lifecycle and uses the existing Worker/JobRegistry. No parallel runtime. */
export class MetricScheduler {
  constructor(private readonly store: MysqlScheduleStore, private readonly packages: PackageRegistry,
    private readonly access: CollectorAccess, private readonly clock = Date.now,
    private readonly collect?: PackageExecution['collect'],
    private readonly formalization?: {reconcile(ref: Ref, revision: number): Promise<void>},
    private readonly collectNow?: CollectNowAuthorizer,
    private readonly scheduleMode: 'templates' | 'legacy-packages' = 'templates') {}
  /** Older source qualification runs own package snapshots and an exact-claim worker. */
  static forLegacyPackages(store: MysqlScheduleStore, packages: PackageRegistry, access: CollectorAccess,
    clock = Date.now, collect?: PackageExecution['collect'],
    formalization?: { reconcile(ref: Ref, revision: number): Promise<void> }): MetricScheduler {
    return new MetricScheduler(store, packages, access, clock, collect, formalization, undefined, 'legacy-packages');
  }
  async tick(): Promise<number> {
    let count = 0;
    const scan = await this.store.scan();
    // Isolate a corrupt row without suppressing other schedules.
    for (const rejected of scan.rejected) {
      platformLogs.record({ component: 'metrics', eventType: 'collection.scan_skipped', status: 'failed',
        errorCode: rejected.code, correlationId: rejected.resource_key });
    }
    const candidates = this.scheduleMode === 'legacy-packages'
      ? scan.published.map(published => ({ binding: published.binding, resourceKey: refKey(published.binding.resource),
        enqueue: () => this.store.enqueue(published, this.clock()) }))
      : scan.templates.map(template => ({ binding: template.decoded.binding, resourceKey: template.resource_key,
        enqueue: () => this.store.enqueueTemplate(template, this.clock()) }));
    for (const candidate of candidates) {
      let phase = 'formalization';
      try {
        await this.formalization?.reconcile(candidate.binding.resource, candidate.binding.revision);
        phase = 'enqueue';
        if (await candidate.enqueue()) count++;
      } catch (error) {
        if (globalSchedulingFailure(error)) throw error;
        platformLogs.record({ component: 'metrics', eventType: `collection.${phase}_failed`, status: 'failed',
          errorCode: schedulingFailureCode(error), correlationId: candidate.resourceKey });
      }
    }
    return count;
  }
  /**
   * Execute one template revision: the plan's own releases, collectors and
   * metrics, read-only through the same access object, committed as formal
   * normalized observations once the job's fences still hold. The fence decides
   * whether this run is a cadence tick or one persisted manual task; the plan,
   * reads and writer below are the same.
   */
  private async executeTemplate(ref: Ref, revision: number, job: ClaimedJob, context: JobExecutionContext,
    fenceFor: (executionContext: JobExecutionContext) => TemplateRunFence): Promise<void> {
    const reservation = await this.store.reserve(ref);
    if (!reservation) throw new Error('SCHEDULE_CAPACITY');
    const started = this.clock();
    let reads = 0, inFlight = false, cancelled = false, uncertain = false;
    const controller = new AbortController();
    const signal = ref.type === 'instance'
      ? AbortSignal.any([controller.signal, instanceAccessLifecycle.signal(ref.id)]) : controller.signal;
    const executionContext = { ...context, signal };
    const fence = fenceFor(executionContext);
    let results: PackageResults = [];
    const attempts = () => results.flatMap(entry => entry.result.attempts.map(attempt => ({
      id: String(attempt.id), collector_id: attempt.collector_id, status: String(attempt.status),
    })));
    let cancellationRecord: Promise<void> | undefined;
    const cancel = (reason: unknown) => {
      if (cancelled) return;
      cancelled = true; uncertain = inFlight; controller.abort(reason);
      cancellationRecord = job.type === COLLECT_NOW_JOB_TYPE ? Promise.resolve()
        : this.store.event(ref, revision, job.id, 'cancellation_requested', inFlight, this.clock() - started, reads);
      void cancellationRecord.catch(() => undefined);
    };
    const abort = () => cancel(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = await this.store.currentTemplate(this.store.pool, ref);
      if (!current || current.binding.revision !== revision) {
        if (fence.onMissingBinding() === 'return') return;
        throw new Error('SCHEDULE_SUPERSEDED');
      }
      const plan = current.pending.plan;
      const budget = discoveryBudget(plan.parameters);
      rule(!budget || budget.series_upper_bound <= plan.settings.max_series_per_resource,'DISCOVERY_SERIES_BUDGET');
      const settings = {...plan.settings,timeout_ms:Math.min(plan.settings.timeout_ms,budget?.timeout_ms??Infinity),
        max_rows:Math.min(plan.settings.max_rows,budget?.max_rows??Infinity)};
      timer = setTimeout(() => cancel(new Error('SCHEDULE_TIMEOUT')), settings.timeout_ms);
      // Resolving a credential can wait on a lock too: the live fence must hold
      // before it starts, not only at the commit that refuses a late result.
      await fence.assertCurrent();
      const access: Awaited<ReturnType<CollectorAccess['resolve']>> = settings.enabled ? await this.access.resolve(ref) : {
        resource: { type: ref.type, id: String(ref.id), attributes: {} }, credential_ref: 'credential:disabled', evidence: {},
        resolve: async () => { throw new Error('SCHEDULE_DISABLED'); },
      };
      rule(access.resource.type === ref.type && access.resource.id === String(ref.id), 'SCHEDULE_ACCESS_IDENTITY');
      signal.throwIfAborted();
      const snapshot = await fence.begin();
      if (!snapshot) return;
      // Before every request, retry and post-IO boundary: the same live template
      // job fence the legacy path applies, so a stale job cannot keep reading the
      // target even though its eventual commit would be refused.
      const check = async () => {
        signal.throwIfAborted();
        await reservation.connection.ping();
        await access.assertCurrent?.();
        // Credential and target checks may wait; authorize only after they finish.
        await fence.assertCurrent(snapshot);
        signal.throwIfAborted();
      };
      await check();
      let states = snapshot.states;
      for (const release of snapshot.releases ?? snapshot.plan.releases) {
        if (release.steps.length === 0) continue;
        const result = await runPackage(this.packages, {
          package: { ...release.release }, credential_ref: access.credential_ref,
          overrides: { enabled: settings.enabled, interval_ms: settings.interval_ms, timeout_ms: settings.timeout_ms,
            stale_after_ms: settings.stale_after_ms, max_counter_gap_ms: settings.max_counter_gap_ms, max_rows: settings.max_rows },
        }, {
          ...access, binding_id: refKey(ref), attempt_id: `${job.id}:${job.fencingToken}:${release.release_ref}`,
          config_revision: revision, observed_at: new Date(this.clock()).toISOString(),
          clock: () => new Date(this.clock()).toISOString(), signal,
          collector_ids: release.collector_ids, metric_keys: release.metric_keys, states, item_intervals_ms: itemIntervals([release]),
          previous_capabilities: release.steps.flatMap(step => step.items.map(item => item.capability)),
          before_request: check,
          collect: async (...args) => {
            await check(); inFlight = true;
            reads += args[1].method === 'ssh' ? 2 : 1;
            try {
              const collector = this.collect ?? (await import('../packages/adapters.js')).collectFixed;
              return await collector(args[0], args[1], ...args.slice(2) as [typeof args[2], typeof args[3], typeof args[4]]);
            } finally { inFlight = false; }
          },
        });
        states = result.states;
        results.push({ release: { ...release.release }, result });
      }
      signal.throwIfAborted();
      await check();
      if (results.some(entry => entry.result.attempts.length)
        && results.every(entry => entry.result.attempts.every(attempt => attempt.status === 'failed'))) {
        await fence.recordFailure(snapshot, results);
        throw new Error('SCHEDULE_COLLECTION_FAILED');
      }
      const committed = await fence.commit(snapshot, results);
      platformLogs.record({ component: 'metrics', eventType: 'collection.committed', status: committed ? 'ok' : 'unknown',
        correlationId: job.id, jobType: job.type, durationMs: Math.max(0, this.clock() - started) });
      if (job.type !== COLLECT_NOW_JOB_TYPE) await this.store.event(ref, revision, job.id,
        committed ? 'committed' : 'late_result_discarded', false, this.clock() - started, reads);
      if (committed) await fence.afterCommit?.();
    } catch (error) {
      const superseded = error instanceof Error && error.message === 'SCHEDULE_SUPERSEDED';
      const stale = error instanceof Error && error.message === 'SCHEDULE_STALE_EXECUTION';
      const code = cancelled ? 'cancelled_result_uncertain' : superseded || stale ? 'late_result_discarded' : 'collection_failed';
      if (job.type !== COLLECT_NOW_JOB_TYPE) await this.store.event(ref, revision, job.id, code,
        uncertain || inFlight, this.clock() - started, reads);
      // A manual task always records why it ended; a cadence tick keeps its own event.
      await fence.fail(code, uncertain || inFlight, attempts());
      if (superseded) return;
      throw new Error(code);
    } finally {
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      try { await cancellationRecord; } finally { await reservation.release(); }
    }
  }

  register(registry: JobRegistry): void {
    registry.register(JOB_TYPE, async (payload, job, context) => {
      const { resource: ref, revision } = Payload.parse(payload);
      context.signal.throwIfAborted();
      if (this.scheduleMode === 'legacy-packages') return this.runLegacy(ref, revision, job, context);
      return this.executeTemplate(ref, revision, job, context, execution => ({
        onMissingBinding: () => 'return',
        assertCurrent: snapshot => this.store.assertCurrentTemplate(ref, revision, job, execution, snapshot?.snmpInventoryTarget),
        begin: () => this.store.beginTemplate(ref, revision, job, execution, this.clock()),
        commit: (snapshot, results) => this.store.commitTemplate(snapshot, results, job, execution, this.clock()),
        recordFailure: (snapshot, results) => this.store.recordTemplateFailure(snapshot, results, job, execution, this.clock()),
        fail: async () => undefined,
      }));
    });
    if (this.scheduleMode === 'legacy-packages') return;
    // Manual collection: the same plan and writer, fenced by one persisted task.
    registry.register(COLLECT_NOW_JOB_TYPE, async (payload, job, context) => {
      const { resource: ref, revision, request_id } = CollectNowPayload.parse(payload);
      context.signal.throwIfAborted();
      const execution = await this.store.collectExecutionContext(request_id);
      // Not this job's task (replaced or never admitted): it owns no result.
      if (!execution || execution.task.job_id !== job.id) return;
      rule(execution.task.resource.type === ref.type && execution.task.resource.id === ref.id
        && execution.task.revision === revision, 'COLLECT_TASK_IDENTITY');
      if (!this.collectNow) throw new Error('COLLECT_NOW_UNAVAILABLE');
      const authorizer = this.collectNow;
      const authorizeOn = (c: { execute(sql: string, values?: any[]): Promise<unknown> }) =>
        authorizer.authorizeOn(c, execution.actorId, execution.sessionVersion, ref);
      return this.executeTemplate(ref, revision, job, context, exec => ({
        onMissingBinding: () => 'throw',
        assertCurrent: snapshot => this.store.assertCollectNow(ref, revision, request_id, job, exec, authorizeOn, snapshot?.snmpInventoryTarget),
        begin: () => this.store.beginCollectNow(ref, revision, request_id, job, exec, this.clock(), authorizeOn),
        commit: async (snapshot, results) => {
          const committed = await this.store.commitCollectNow(ref, revision, request_id, snapshot, results,
            job, exec, this.clock(), authorizeOn);
          return committed;
        },
        recordFailure: async () => undefined,
        fail: async (code, uncertain, attempts) => {
          const state = code === 'cancelled_result_uncertain' ? (uncertain ? 'unknown' : 'cancelled')
            : code === 'late_result_discarded' ? 'unknown' : 'failed';
          await this.store.failCollectNow(ref, revision, request_id, job, exec, state, code, attempts, this.clock(), authorizeOn);
        },
        afterCommit: async () => {
          // The same formalization pass the cadence tick runs; never a second writer.
          try { await this.formalization?.reconcile(ref, revision); } catch { /* samples are already formal; the tick retries */ }
        },
      }));
    });
  }

  private async runLegacy(ref: Ref, revision: number, job: ClaimedJob, context: JobExecutionContext): Promise<void> {
    const reservation = await this.store.reserve(ref);
    if (!reservation) throw new Error('SCHEDULE_CAPACITY');
    const started = this.clock();
    let reads = 0, inFlight = false, cancelled = false, uncertain = false;
    const controller = new AbortController();
    const signal = ref.type === 'instance' ? AbortSignal.any([controller.signal, instanceAccessLifecycle.signal(ref.id)]) : controller.signal;
    const executionContext = { ...context, signal };
    let cancellationRecord: Promise<void> | undefined;
    const cancel = (reason: unknown) => {
      if (cancelled) return;
      cancelled = true; uncertain = inFlight; controller.abort(reason);
      cancellationRecord = this.store.event(ref, revision, job.id, 'cancellation_requested', inFlight, this.clock() - started, reads);
      // Retain the promise for foreground cleanup; avoid an unhandled rejection while IO is still pending.
      void cancellationRecord.catch(() => undefined);
    };
    const abort = () => cancel(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = await this.store.current(this.store.pool, ref);
      if (!current || current.binding.revision !== revision) return;
      const initial = compilePlan(this.packages, current.resolved);
      timer = setTimeout(() => cancel(new Error('SCHEDULE_TIMEOUT')), initial.timeoutMs);
      await this.store.assertCurrent(ref, revision, job, executionContext);
      const access: Awaited<ReturnType<CollectorAccess['resolve']>> = current.resolved.settings.enabled ? await this.access.resolve(ref) : {
        resource: { type: ref.type, id: String(ref.id), attributes: {} }, credential_ref: 'credential:disabled', evidence: {},
        resolve: async () => { throw new Error('SCHEDULE_DISABLED'); },
      };
      rule(access.resource.type === ref.type && access.resource.id === String(ref.id), 'SCHEDULE_ACCESS_IDENTITY');
      signal.throwIfAborted();
      const snapshot = await this.store.begin(ref, revision, job, executionContext, this.clock(), access.resource);
      if (!snapshot) return;
      platformLogs.record({ component: 'metrics', eventType: 'collection.begun', status: 'ok', correlationId: job.id, jobType: JOB_TYPE, durationMs: Math.max(0, this.clock() - started) });
      const { plan, published } = snapshot;
      const settings = published.resolved.settings;
      const check = async () => {
        signal.throwIfAborted();
        await reservation.connection.ping();
        await access.assertCurrent?.();
        await this.store.assertCurrent(ref, revision, job, executionContext);
        signal.throwIfAborted();
      };
      await check();
      const capture = new SourceSnapshotCapture();
      const result = await runPackage(this.packages, { package: published.binding.package, credential_ref: access.credential_ref,
        overrides: { enabled: settings.enabled, interval_ms: settings.interval_ms, timeout_ms: settings.timeout_ms,
          stale_after_ms: settings.stale_after_ms, max_counter_gap_ms: settings.max_counter_gap_ms, max_rows: settings.max_rows } }, {
        ...access, resolve: access.resolve, resource: access.resource, binding_id: refKey(ref), attempt_id: `${job.id}:${job.fencingToken}`,
        // Metadata can be observed after job start; started still anchors elapsed time and cancellation.
        config_revision: revision, observed_at: new Date(this.clock()).toISOString(), clock: () => new Date(this.clock()).toISOString(),
        signal, collector_ids: plan.collectorIds, metric_keys: plan.metricKeys, states: snapshot.states,
        previous_capabilities: published.resolved.metric_templates.map(t => t.capability), before_request: check,
        collect: async (...args) => {
          await check(); inFlight = true;
          reads += args[1].method === 'ssh' ? 2 : 1;
          try {
            const collector = this.collect ?? (await import('../packages/adapters.js')).collectFixed;
            return await collector(args[0], capture.inCollector(args[0], args[1]), ...args.slice(2) as [typeof args[2],typeof args[3],typeof args[4]]);
          } finally { inFlight = false; }
        },
      });
      signal.throwIfAborted();
      await check();
      // Failed batches are retried by the existing Worker. Partial success is committed without re-querying healthy outputs.
      if (result.attempts.length && result.attempts.every(a => a.status === 'failed')) {
        await this.store.recordFailure(snapshot, result, job, executionContext, this.clock());
        throw new Error('SCHEDULE_COLLECTION_FAILED');
      }
      result.source_validation = capture.compare(ref, String(access.resource.attributes['db.engine']?.value ?? ''),
        result.observations.map(o=>o.observation), this.packages.catalog(published.binding.package), this.packages.get(published.binding.package).package.collectors);
      const committed = await this.store.commit(snapshot, result, job, executionContext, this.clock());
      platformLogs.record({ component: 'metrics', eventType: 'collection.committed', status: committed ? 'ok' : 'unknown', correlationId: job.id, jobType: JOB_TYPE, durationMs: Math.max(0, this.clock() - started) });
      await this.store.event(ref, revision, job.id, committed ? 'committed' : 'late_result_discarded', false, this.clock() - started, reads);
    } catch (error) {
      // A template row (or a corrupt snapshot) can never become collectable by
      // retrying the same legacy job: record one stable diagnostic and end it.
      if (isTemplateBindingUnsupported(error)) {
        await this.store.event(ref, revision, job.id, 'template_binding_unsupported', false, this.clock() - started, reads);
        return;
      }
      const payloadCode = bindingReadCode(error);
      if (payloadCode !== null) {
        await this.store.event(ref, revision, job.id, 'binding_payload_invalid', false, this.clock() - started, reads);
        return;
      }
      // Never store remote errors, credentials or SQL. Abort cannot retract an already issued request.
      const superseded = error instanceof Error && error.message === 'SCHEDULE_SUPERSEDED';
      const stale = error instanceof Error && error.message === 'SCHEDULE_STALE_EXECUTION';
      const code = cancelled ? 'cancelled_result_uncertain' : superseded || stale
        ? 'late_result_discarded' : 'collection_failed';
      await this.store.event(ref, revision, job.id, code, uncertain || inFlight, this.clock() - started, reads);
      // A superseded revision can never become current again; retrying it can starve the replacement job.
      if (superseded) return;
      throw new Error(code);
    } finally {
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      try { await cancellationRecord; } finally { await reservation.release(); }
    }
  }
}
