import { z } from 'zod';
import type { Resource } from '../../contracts/metrics-v2/index.js';
import type { JobRegistry } from '../../workflows/job-registry.js';
import { runPackage, type PackageExecution } from '../packages/runner.js';
import type { PackageRegistry } from '../packages/model.js';
import { type Ref, RefSchema, refKey, rule } from '../policy/model.js';
import { compilePlan } from './compiler.js';
import { JOB_TYPE, MysqlScheduleStore } from './store.js';

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
    private readonly collect?: PackageExecution['collect']) {}
  async tick(): Promise<number> {
    let count = 0;
    for (const published of await this.store.list()) if (await this.store.enqueue(published, this.clock())) count++;
    return count;
  }
  register(registry: JobRegistry): void {
    registry.register(JOB_TYPE, async (payload, job, context) => {
      const { resource: ref, revision } = Payload.parse(payload);
      context.signal.throwIfAborted();
      const reservation = await this.store.reserve(ref);
      if (!reservation) throw new Error('SCHEDULE_CAPACITY');
      const started = this.clock();
      let reads = 0, inFlight = false, cancelled = false, uncertain = false;
      const controller = new AbortController();
      const executionContext = { ...context, signal: controller.signal };
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
        controller.signal.throwIfAborted();
        const snapshot = await this.store.begin(ref, revision, job, executionContext, this.clock(), access.resource);
        if (!snapshot) return;
        const { plan, published } = snapshot;
        const settings = published.resolved.settings;
        const check = async () => {
          controller.signal.throwIfAborted();
          await reservation.connection.ping();
          await this.store.assertCurrent(ref, revision, job, executionContext);
          await access.assertCurrent?.();
          controller.signal.throwIfAborted();
        };
        await check();
        const result = await runPackage(this.packages, { package: published.binding.package, credential_ref: access.credential_ref,
          overrides: { enabled: settings.enabled, interval_ms: settings.interval_ms, timeout_ms: settings.timeout_ms,
            stale_after_ms: settings.stale_after_ms, max_counter_gap_ms: settings.max_counter_gap_ms, max_rows: settings.max_rows } }, {
          ...access, resource: access.resource, binding_id: refKey(ref), attempt_id: `${job.id}:${job.fencingToken}`,
          config_revision: revision, observed_at: new Date(started).toISOString(), clock: () => new Date(this.clock()).toISOString(),
          signal: controller.signal, collector_ids: plan.collectorIds, metric_keys: plan.metricKeys, states: snapshot.states,
          previous_capabilities: published.resolved.metric_templates.map(t => t.capability), before_request: check,
          collect: async (...args) => {
            await check(); inFlight = true;
            reads += args[1].method === 'ssh' ? 2 : 1;
            try {
              const collector = this.collect ?? (await import('../packages/adapters.js')).collectFixed;
              return await collector(...args);
            } finally { inFlight = false; }
          },
        });
        controller.signal.throwIfAborted();
        await check();
        // Failed batches are retried by the existing Worker. Partial success is committed without re-querying healthy outputs.
        if (result.attempts.length && result.attempts.every(a => a.status === 'failed')) {
          await this.store.recordFailure(snapshot, result, job, executionContext, this.clock());
          throw new Error('SCHEDULE_COLLECTION_FAILED');
        }
        const committed = await this.store.commit(snapshot, result, job, executionContext, this.clock());
        await this.store.event(ref, revision, job.id, committed ? 'committed' : 'late_result_discarded', false, this.clock() - started, reads);
      } catch (error) {
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
