/** D1 process fence plus durable checks. IDs are never reused after tombstoning. */
export class InstanceAccessLifecycle {
  private readonly revoked = new Map<number, AbortController>();
  private readonly operations = new Map<number, Set<Promise<unknown>>>();
  private readonly temporary = new Map<number, Set<() => Promise<void>>>();
  constructor(private check?: (id: number) => Promise<boolean>) {}
  configure(check: (id: number) => Promise<boolean>): void { this.check = check; }
  isRevoked(id: number): boolean { return this.revoked.get(id)?.signal.aborted === true; }
  signal(id: number): AbortSignal {
    let controller = this.revoked.get(id);
    if (!controller) { controller = new AbortController(); this.revoked.set(id, controller); }
    return controller.signal;
  }
  revoke(id: number): void {
    this.signal(id);
    this.revoked.get(id)!.abort(new Error('INSTANCE_REMOVED'));
  }
  forgetMissing(id: number): void {
    // A rejected DELETE of a future ID must not fence a later legitimate INSERT.
    if (!this.operations.has(id) && !this.temporary.has(id)) this.revoked.delete(id);
  }
  async assertAvailable(id: number): Promise<void> {
    if (this.isRevoked(id)) throw new Error('INSTANCE_REMOVED');
    if (this.check && !await this.check(id)) {
      this.revoke(id);
      throw new Error('INSTANCE_REMOVED');
    }
    // A deletion may have committed while the durable lookup was in flight.
    if (this.isRevoked(id)) throw new Error('INSTANCE_REMOVED');
  }
  track<T>(id: number, action: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(action);
    let operations = this.operations.get(id);
    if (!operations) { operations = new Set(); this.operations.set(id, operations); }
    operations.add(pending);
    const finish = () => { operations!.delete(pending); if (!operations!.size) this.operations.delete(id); };
    pending.then(finish, finish);
    return pending;
  }
  async drain(id: number): Promise<void> {
    while (this.operations.get(id)?.size) await Promise.allSettled(this.operations.get(id)!);
  }
  ownTemporary(id: number, close: () => Promise<void>): () => Promise<void> {
    let handles = this.temporary.get(id);
    if (!handles) { handles = new Set(); this.temporary.set(id, handles); }
    let pending: Promise<void> | undefined, closed = false;
    const cleanup = () => {
      if (closed) return Promise.resolve();
      return pending ??= Promise.resolve().then(close).then(() => {
        closed = true; handles!.delete(cleanup);
        if (!handles!.size) this.temporary.delete(id);
      }).finally(() => { pending = undefined; });
    };
    handles.add(cleanup);
    return cleanup;
  }
  async closeTemporary(id: number): Promise<void> {
    const outcomes = await Promise.allSettled([...(this.temporary.get(id) ?? [])].map(close => close()));
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('TEMPORARY_CLOSE_PENDING');
  }
  /** Guard driver calls even when a caller retained a connection before deletion. */
  guardDriver<T extends object>(id: number, driver: T): T {
    return new Proxy(driver, { get: (target, key) => {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!['query', 'execute', 'ping', 'connect', 'getConnection'].includes(String(key))) return value.bind(target);
      return (...args: unknown[]) => this.track(id, async () => {
        await this.assertAvailable(id);
        if (this.isRevoked(id)) throw new Error('INSTANCE_REMOVED');
        const result = await value.apply(target, args);
        if (key === 'getConnection') {
          if (this.isRevoked(id)) {
            const close = this.ownTemporary(id, async () => {
              if (typeof result.release === 'function') result.release();
              else await result.close();
            });
            await close();
            throw new Error('INSTANCE_REMOVED');
          }
          return this.guardDriver(id, result);
        }
        return result;
      });
    } });
  }
}

export async function cleanupDeadline<T>(operation: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLEANUP_PENDING')), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
export const instanceAccessLifecycle = new InstanceAccessLifecycle();
