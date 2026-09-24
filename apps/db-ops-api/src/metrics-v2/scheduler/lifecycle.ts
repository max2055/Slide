import type { JobRegistry } from '../../workflows/job-registry.js';
import { JOB_TYPE } from './store.js';

export interface SchedulerLifecycleOptions {
  enabled: boolean;
  intervalMs?: number;
  shutdownMs?: number;
  report?: (event: { code: string; queued?: number; durationMs?: number }) => void;
}

/** Owns only the scheduler tick. Jobs run on the application's shared WorkerRuntime. */
export class MetricSchedulerLifecycle {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private started = false;
  private readonly intervalMs: number;
  private readonly shutdownMs: number;

  constructor(private readonly scheduler: { tick(): Promise<number>; register(registry: JobRegistry): void },
    private readonly options: SchedulerLifecycleOptions) {
    this.intervalMs = options.intervalMs ?? 1000;
    this.shutdownMs = options.shutdownMs ?? 5000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1000 || this.intervalMs > 60000
      || !Number.isSafeInteger(this.shutdownMs) || this.shutdownMs < 1 || this.shutdownMs > 30000) {
      throw new Error('METRIC_LIFECYCLE_CONFIG');
    }
  }

  async start(registry: JobRegistry, ready: () => Promise<void>): Promise<void> {
    if (this.started || this.stopped) throw new Error('METRIC_LIFECYCLE_ALREADY_STARTED');
    this.started = true;
    if (!this.options.enabled) {
      // A restart with collection disabled must not execute durable jobs left by a previous run.
      registry.register(JOB_TYPE, async () => { throw new Error('METRIC_COLLECTION_DISABLED'); });
      return;
    }
    await ready();
    if (this.stopped) return;
    this.scheduler.register(registry);
    await this.tick();
    if (!this.stopped) this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    const started = Date.now();
    this.pending = Promise.resolve().then(() => this.scheduler.tick()).then(queued => {
      this.report({ code: 'METRIC_TICK_OK', queued, durationMs: Date.now() - started });
    }, () => {
      // SQL/transport error messages may contain credentials; only stable codes leave this boundary.
      this.report({ code: 'METRIC_TICK_FAILED', durationMs: Date.now() - started });
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private report(event: Parameters<NonNullable<SchedulerLifecycleOptions['report']>>[0]): void {
    try { this.options.report?.(event); } catch { /* Observability must not orphan the tick. */ }
  }

  async stop(): Promise<boolean> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (!this.pending) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.pending.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.shutdownMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

export function metricCollectionEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('METRIC_COLLECTION_ENABLED_INVALID');
}
