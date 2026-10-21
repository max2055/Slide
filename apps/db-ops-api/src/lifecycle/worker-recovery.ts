import { WorkerStartup, type StartupLease } from './worker-startup.js';

export type RecoveryState = 'starting' | 'ready' | 'degraded' | 'recovering' | 'standby' | 'blocked' | 'stopping';
interface Generation { startup: WorkerStartup; lease: StartupLease; }

/** Single process, single recovery loop, immutable worker generations. Initial
 * standby never promotes. A recovering leader that loses election stays standby. */
export class WorkerRecovery {
  state: RecoveryState = 'starting';
  reason = 'WORKER_STARTING';
  private generation?: Generation;
  private recovery?: Promise<void>;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  private startWorkers!: (startup: WorkerStartup) => Promise<void>;

  constructor(private readonly options: {
    lease: () => StartupLease;
    probe: () => Promise<boolean>;
    close: () => Promise<void>;
    report?: (state: RecoveryState, reason: string) => void;
    delayMs?: number; maxDelayMs?: number; drainMs?: number; random?: () => number;
  }) {}

  private isStopping(): boolean { return this.state === 'stopping'; }

  get ready() { return this.state === 'ready' && this.generation?.startup.ready === true; }
  async assertOwned(): Promise<void> {
    if (!this.ready) throw new Error('WORKER_LEASE_UNAVAILABLE');
    await this.generation!.startup.assertOwned();
  }
  private transition(state: RecoveryState, reason: string) {
    this.state = state; this.reason = reason; this.options.report?.(state, reason);
  }
  private create(): Generation {
    const lease = this.options.lease();
    const startup = new WorkerStartup(lease, this.options.close, {
      releaseOnStop: false,
      onStopping: reason => {
        if (this.isStopping()) return;
        if (!this.transient(reason)) { this.transition('blocked', 'WORKER_INITIALIZATION_FAILED'); return; }
        this.transition('degraded', reason.message);
        // Defer until WorkerStartup has published its stop promise.
        queueMicrotask(() => {
          if (!this.recovery && this.state === 'degraded') {
            this.recovery = this.recover().finally(() => { this.recovery = undefined; });
          }
        });
      },
    });
    return { lease, startup };
  }
  async start(api: () => Promise<void>, workers: (startup: WorkerStartup) => Promise<void>) {
    this.startWorkers = workers;
    this.generation = this.create();
    try {
      await this.generation.startup.start(api, () => workers(this.generation!.startup));
      if (this.isStopping()) return;
      if (!this.generation.startup.signal.aborted) this.transition(this.generation.startup.ready ? 'ready' : 'standby', this.generation.startup.ready ? 'WORKER_READY' : 'WORKER_LEASE_UNAVAILABLE');
    } catch (error) {
      if (!this.transient(error)) { this.transition('blocked', 'WORKER_INITIALIZATION_FAILED'); throw error; }
    }
  }
  degrade(reason = new Error('PLATFORM_UNAVAILABLE')) {
    if (this.state === 'ready') void this.generation?.startup.stop(reason).catch(() => {});
  }
  private transient(error: unknown): boolean {
    return /^(WORKER_LEASE_|PLATFORM_)/.test((error as Error)?.message ?? '') ||
      /^(PLATFORM_|ECONN|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR|EPIPE|ER_SERVER_SHUTDOWN|ER_LOCK_)/.test(String((error as { code?: string })?.code ?? ''));
  }
  private async drain(generation: Generation): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = generation.startup.drain();
      const result = await Promise.race([stopped.then(() => true), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), this.options.drainMs ?? 10_000);
      })]);
      if (!result && !this.isStopping()) this.transition('blocked', 'WORKER_DRAIN_BLOCKED');
      // Never abandon the old generation. It may resume recovery only after
      // actual drain; a rejected close remains blocked until explicit repair.
      await stopped;
      return true;
    } catch {
      if (!this.isStopping()) this.transition('blocked', 'WORKER_DRAIN_FAILED');
      return false;
    } finally { if (timer) clearTimeout(timer); }
  }
  private async recover() {
    let attempts = 0;
    while (!this.isStopping()) {
      const previous = this.generation!;
      if (!await this.drain(previous) || this.isStopping()) return;
      this.transition('recovering', 'PLATFORM_RECOVERING');
      while (!this.isStopping()) {
        const delay = Math.min((this.options.delayMs ?? 1_000) * 2 ** Math.min(attempts++, 8), this.options.maxDelayMs ?? 10_000);
        await new Promise<void>(resolve => {
          this.wake = resolve;
          this.timer = setTimeout(resolve, delay * (0.75 + (this.options.random?.() ?? Math.random()) * 0.25));
        });
        this.wake = undefined; this.timer = undefined;
        if (this.isStopping()) return;
        try {
          if (!await this.options.probe()) continue;
          await previous.lease.release();
          if (this.isStopping()) return;
          const next = this.create();
          this.generation = next;
          try { await next.startup.start(async () => {}, () => this.startWorkers(next.startup)); }
          catch (error) {
            if (!this.transient(error)) { this.transition('blocked', 'WORKER_INITIALIZATION_FAILED'); return; }
            break;
          }
          if (this.isStopping()) return;
          this.transition(next.startup.ready ? 'ready' : 'standby', next.startup.ready ? 'WORKER_READY' : 'WORKER_LEASE_UNAVAILABLE');
          return;
        } catch (error) {
          if ((error as Error)?.message === 'WORKER_SCHEMA_INCOMPATIBLE') {
            this.transition('blocked', 'WORKER_SCHEMA_INCOMPATIBLE'); return;
          }
          // Dependency probes are bounded by their driver boundary and never overlap.
        }
      }
    }
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.transition('stopping', 'WORKER_STOPPED');
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    this.closing = (async () => {
      const generation = this.generation;
      await generation?.startup.drain();
      await this.recovery;
      // Final DB release failure must not cause another recovery loop.
      await generation?.lease.release().catch(() => {});
    })();
    return this.closing;
  }
}
