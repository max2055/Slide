import { SourceSnapshotCapture } from '../rollout/source-shadow.js';
import { platformLogs } from '../../platform/structured-log-evidence-adapter.js';
import { instanceAccessLifecycle } from '../../resources/instance-access-lifecycle.js';
import { z } from 'zod';
import type { Resource } from '../../contracts/metrics/index.js';
import type { JobRegistry } from '../../workflows/job-registry.js';
import { runPackage, type PackageExecution } from '../packages/runner.js';
import type { PackageRegistry } from '../packages/model.js';
import { type Ref, RefSchema, refKey, rule } from '../policy/model.js';
import { bindingReadCode, isTemplateBindingUnsupported } from '../bindings/package-reader.js';
import { compilePlan } from './compiler.js';
import { JOB_TYPE, MysqlScheduleStore } from './store.js';
import type { ClaimedJob, JobExecutionContext } from '../../workflows/worker-runtime.js';

const Payload = z.strictObject({ resource: RefSchema, revision: z.number().int().positive() });
export interface CollectorAccess {
  /** Must authorize this exact resource and resolve only its own credential reference. */
  resolve(ref: Ref): Promise<Pick<PackageExecution, 'resolve' | 'evidence'> & {
    credential_ref: string; resource: Resource; assertCurrent?: () => Promise<void>;
  }>;
}
/** Host calls tick on its existing lifecycle and uses the existing Worker/JobRegistry. No parallel runtime. */
export class MetricScheduler {
  constructor(private readonly store: MysqlScheduleStore, private readonly packages: PackageRegistry,
    private readonly access: CollectorAccess, private readonly clock = Date.now,
    private readonly collect?: PackageExecution['collect'],
    private readonly formalization?: {reconcile(ref: Ref, revision: number): Promise<void>}) {}
  async tick(): Promise<number> {
    let count = 0;
    const scan = await this.store.scan();
    // A template/corrupt row is isolated with a stable diagnostic; it never blocks
    // a legal legacy row from formalizing or enqueueing.
    for (const rejected of scan.rejected) {
      platformLogs.record({ component: 'metrics', eventType: 'collection.scan_skipped', status: 'failed',
        errorCode: rejected.code, correlationId: rejected.resource_key });
    }
    for (const template of scan.templates) {
      try {
        await this.formalization?.reconcile(template.decoded.binding.resource, template.decoded.binding.revision);
        if (await this.store.enqueueTemplate(template, this.clock())) count++;
      } catch (error) {
        const code = bindingReadCode(error);
        if (code === null) throw error;
        platformLogs.record({ component: 'metrics', eventType: 'collection.scan_skipped', status: 'failed',
          errorCode: code, correlationId: template.resource_key });
      }
    }
    for (const published of scan.published) {
      try {
        await this.formalization?.reconcile(published.binding.resource, published.binding.revision);
        if (await this.store.enqueue(published, this.clock())) count++;
      } catch (error) {
        // The row was replaced between the scan and the fenced re-read.
        const code = bindingReadCode(error);
        if (code === null) throw error;
        platformLogs.record({ component: 'metrics', eventType: 'collection.scan_skipped', status: 'failed',
          errorCode: code, correlationId: refKey(published.binding.resource) });
      }
    }
    return count;
  }
  /**
   * Execute one template revision: the plan's own releases, collectors and
   * metrics, read-only through the same access object, committed as formal
   * normalized observations once the job's fences still hold.
   */
  private async runTemplate(ref: Ref, revision: number, job: ClaimedJob, context: JobExecutionContext): Promise<void> {
    const reservation = await this.store.reserve(ref);
    if (!reservation) throw new Error('SCHEDULE_CAPACITY');
    const started = this.clock();
    let reads = 0, inFlight = false, cancelled = false, uncertain = false;
    const controller = new AbortController();
    const signal = ref.type === 'instance'
      ? AbortSignal.any([controller.signal, instanceAccessLifecycle.signal(ref.id)]) : controller.signal;
    const executionContext = { ...context, signal };
    let cancellationRecord: Promise<void> | undefined;
    const cancel = (reason: unknown) => {
      if (cancelled) return;
      cancelled = true; uncertain = inFlight; controller.abort(reason);
      cancellationRecord = this.store.event(ref, revision, job.id, 'cancellation_requested', inFlight, this.clock() - started, reads);
      void cancellationRecord.catch(() => undefined);
    };
    const abort = () => cancel(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = await this.store.currentTemplate(this.store.pool, ref);
      if (!current || current.binding.revision !== revision) return;
      const plan = current.pending.plan;
      timer = setTimeout(() => cancel(new Error('SCHEDULE_TIMEOUT')), plan.settings.timeout_ms);
      const settings = plan.settings;
      // Resolving a credential can wait on a lock too: the live fence must hold
      // before it starts, not only at the commit that refuses a late result.
      await this.store.assertCurrentTemplate(ref, revision, job, executionContext);
      const access: Awaited<ReturnType<CollectorAccess['resolve']>> = settings.enabled ? await this.access.resolve(ref) : {
        resource: { type: ref.type, id: String(ref.id), attributes: {} }, credential_ref: 'credential:disabled', evidence: {},
        resolve: async () => { throw new Error('SCHEDULE_DISABLED'); },
      };
      rule(access.resource.type === ref.type && access.resource.id === String(ref.id), 'SCHEDULE_ACCESS_IDENTITY');
      signal.throwIfAborted();
      const snapshot = await this.store.beginTemplate(ref, revision, job, executionContext, this.clock());
      if (!snapshot) return;
      // Before every request, retry and post-IO boundary: the same live template
      // job fence the legacy path applies, so a stale job cannot keep reading the
      // target even though its eventual commit would be refused.
      const check = async () => {
        signal.throwIfAborted();
        await reservation.connection.ping();
        await this.store.assertCurrentTemplate(ref, revision, job, executionContext);
        await access.assertCurrent?.();
        signal.throwIfAborted();
      };
      await check();
      const results: Array<{ release: { id: string; version: string; digest: string }; result: import('../packages/runner.js').PackageResult }> = [];
      for (const release of plan.releases) {
        if (release.steps.length === 0) continue;
        const result = await runPackage(this.packages, {
          package: { ...release.release }, credential_ref: access.credential_ref,
          overrides: { enabled: settings.enabled, interval_ms: settings.interval_ms, timeout_ms: settings.timeout_ms,
            stale_after_ms: settings.stale_after_ms, max_counter_gap_ms: settings.max_counter_gap_ms, max_rows: settings.max_rows },
        }, {
          ...access, binding_id: refKey(ref), attempt_id: `${job.id}:${job.fencingToken}:${release.release_ref}`,
          config_revision: revision, observed_at: new Date(this.clock()).toISOString(),
          clock: () => new Date(this.clock()).toISOString(), signal,
          collector_ids: release.collector_ids, metric_keys: release.metric_keys, states: snapshot.states,
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
        results.push({ release: { ...release.release }, result });
      }
      signal.throwIfAborted();
      await check();
      if (results.some(entry => entry.result.attempts.length)
        && results.every(entry => entry.result.attempts.every(attempt => attempt.status === 'failed'))) {
        await this.store.recordTemplateFailure(snapshot, results, job, executionContext, this.clock());
        throw new Error('SCHEDULE_COLLECTION_FAILED');
      }
      const committed = await this.store.commitTemplate(snapshot, results, job, executionContext, this.clock());
      platformLogs.record({ component: 'metrics', eventType: 'collection.committed', status: committed ? 'ok' : 'unknown',
        correlationId: job.id, jobType: JOB_TYPE, durationMs: Math.max(0, this.clock() - started) });
      await this.store.event(ref, revision, job.id, committed ? 'committed' : 'late_result_discarded', false,
        this.clock() - started, reads);
    } catch (error) {
      const superseded = error instanceof Error && error.message === 'SCHEDULE_SUPERSEDED';
      const stale = error instanceof Error && error.message === 'SCHEDULE_STALE_EXECUTION';
      const code = cancelled ? 'cancelled_result_uncertain' : superseded || stale ? 'late_result_discarded' : 'collection_failed';
      await this.store.event(ref, revision, job.id, code, uncertain || inFlight, this.clock() - started, reads);
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
      // A template row runs the exact pending plan; the legacy single-package
      // path below never sees a `templates-v1` payload.
      if (await this.store.currentTemplate(this.store.pool, ref) !== null) {
        return this.runTemplate(ref, revision, job, context);
      }
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
          await this.store.assertCurrent(ref, revision, job, executionContext);
          await access.assertCurrent?.();
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
    });
  }
}
