interface StartupLease {
  acquire(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

/** D1: elect once, renew during startup, and never promote a standby automatically. */
export class WorkerStartup {
  private controller = new AbortController();
  private owned = false;
  private initialized = false;
  private timer?: ReturnType<typeof setInterval>;
  private renewal?: Promise<void>;
  private closing?: Promise<void>;
  readonly signal = this.controller.signal;

  constructor(private readonly lease: StartupLease, private readonly close: () => Promise<void>,
    private readonly options: { intervalMs?: number; timeoutMs?: number; onStopped?: () => Promise<void> } = {}) {}

  get ready(): boolean { return this.owned && this.initialized && !this.signal.aborted; }

  async start(api: () => Promise<void>, workers: () => Promise<void>): Promise<void> {
    try {
      this.owned = await this.step(() => this.lease.acquire(), acquired => acquired ? this.lease.release() : Promise.resolve());
      if (this.owned) {
        this.timer = setInterval(() => { void this.assertOwned().catch(() => {}); }, (this.options.intervalMs ?? 10_000));
        await this.assertOwned();
      }
      await this.step(api);
      if (!this.owned) return;
      await this.step(workers);
      await this.assertOwned();
      this.initialized = true;
    } catch (error) {
      await this.stop(error instanceof Error ? error : new Error('WORKER_STARTUP_FAILED'));
      throw error;
    }
  }

  /** Stop waiting on non-cooperative I/O; dispose resources if they arrive after abort. */
  async step<T>(operation: () => Promise<T>, disposeLate?: (value: T) => Promise<void>): Promise<T> {
    this.signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    const pending = Promise.resolve().then(() => { this.signal.throwIfAborted(); return operation(); }).then(async value => {
      if (this.signal.aborted) { await disposeLate?.(value); this.signal.throwIfAborted(); }
      return value;
    });
    try { return await Promise.race([pending, aborted]); }
    finally { this.signal.removeEventListener('abort', onAbort); }
  }

  /** Renewal is serialized and bounded, including checks immediately before effects. */
  async assertOwned(): Promise<void> {
    this.signal.throwIfAborted();
    if (!this.owned) throw new Error('WORKER_LEASE_UNAVAILABLE');
    if (this.renewal) return this.renewal;
    this.renewal = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const renewed = await this.step(() => Promise.race([
          this.lease.renew(),
          new Promise<boolean>((_, reject) => { deadline = setTimeout(() => reject(new Error('WORKER_LEASE_TIMEOUT')), (this.options.timeoutMs ?? 5_000)); }),
        ]));
        if (!renewed) throw new Error('WORKER_LEASE_LOST');
      } catch (error) {
        const reason = error instanceof Error && error.message.startsWith('WORKER_') ? error : new Error('WORKER_LEASE_FAILED');
        // Abort before cleanup awaits anything; no subsequent startup effect may run.
        void this.stop(reason).catch(() => { console.error('[WorkerStartup] WORKER_CLOSE_FAILED'); });
        throw reason;
      } finally { if (deadline) clearTimeout(deadline); }
    })();
    try { await this.renewal; }
    finally { this.renewal = undefined; }
  }

  stop(reason = new Error('WORKER_STOPPED')): Promise<void> {
    if (this.closing) return this.closing;
    this.initialized = false;
    this.controller.abort(reason);
    if (this.timer) clearInterval(this.timer);
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.close();
        if (this.owned) await this.lease.release();
      } finally {
        this.owned = false;
        await this.options.onStopped?.();
      }
    });
    return this.closing;
  }
}
