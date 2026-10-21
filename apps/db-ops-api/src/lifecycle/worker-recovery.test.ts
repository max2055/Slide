import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerRecovery } from './worker-recovery.js';
import type { WorkerStartup } from './worker-startup.js';

afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(owned = true) {
  let available = true, elected = owned, active = 0, maximum = 0;
  const leases: Array<{ acquire: ReturnType<typeof vi.fn>; renew: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  const probe = vi.fn(async () => available);
  const close = vi.fn(async () => { active = 0; });
  const workers = vi.fn(async (_startup: WorkerStartup) => { active++; maximum = Math.max(maximum, active); });
  const api = vi.fn(async () => {});
  const recovery = new WorkerRecovery({ lease: () => {
    const lease = { acquire: vi.fn(async () => elected), renew: vi.fn(async () => {
      if (!available) throw Object.assign(new Error('transport'), { code: 'ECONNRESET' }); return true;
    }), release: vi.fn(async () => {}) };
    leases.push(lease); return lease;
  }, close, probe, delayMs: 100, maxDelayMs: 1_000, drainMs: 200, random: () => 1 });
  return { recovery, leases, probe, close, workers, api,
    offline: () => { available = false; }, online: () => { available = true; }, otherOwner: () => { elected = false; }, maximum: () => maximum };
}

describe('worker dependency recovery', () => {
  it('recovers short, over-TTL and repeated outages without re-registering API or overlapping generations', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.recovery.start(f.api, f.workers);
    const signals = [f.workers.mock.calls[0][0].signal];
    for (const duration of [1_000, 45_000, 1_000]) {
      f.offline();
      await Promise.allSettled([f.recovery.assertOwned(), f.recovery.assertOwned(), f.recovery.assertOwned()]);
      expect(f.recovery.ready).toBe(false);
      await vi.advanceTimersByTimeAsync(duration);
      f.online(); await vi.advanceTimersByTimeAsync(1_100);
      expect(f.recovery.ready).toBe(true);
      signals.push(f.workers.mock.calls.at(-1)![0].signal);
    }
    expect(new Set(signals).size).toBe(4);
    expect(signals.slice(0, -1).every(signal => signal.aborted)).toBe(true);
    expect(f.api).toHaveBeenCalledOnce(); expect(f.workers).toHaveBeenCalledTimes(4);
    expect(f.close).toHaveBeenCalledTimes(3); expect(f.maximum()).toBe(1);
    await f.recovery.stop();
  });
  it('keeps initial standby and a recovering loser API-only without automatic promotion', async () => {
    vi.useFakeTimers();
    const standby = fixture(false); await standby.recovery.start(standby.api, standby.workers);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(standby.recovery.state).toBe('standby'); expect(standby.leases).toHaveLength(1);
    expect(standby.workers).not.toHaveBeenCalled(); await standby.recovery.stop();
    const f = fixture(); await f.recovery.start(f.api, f.workers);
    f.otherOwner(); f.recovery.degrade(); await vi.advanceTimersByTimeAsync(1_100);
    expect(f.recovery.state).toBe('standby');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.leases).toHaveLength(2); expect(f.workers).toHaveBeenCalledOnce();
    await f.recovery.stop();
  });
  it('reports blocked drain and cannot acquire a successor until the old close really settles', async () => {
    vi.useFakeTimers();
    const f = fixture(); const drain = deferred<void>();
    f.close.mockImplementation(async () => drain.promise);
    await f.recovery.start(f.api, f.workers); f.recovery.degrade();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.recovery.state).toBe('blocked'); expect(f.recovery.reason).toBe('WORKER_DRAIN_BLOCKED');
    expect(f.probe).not.toHaveBeenCalled(); expect(f.leases).toHaveLength(1);
    drain.resolve(); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.recovery.ready).toBe(true); await f.recovery.stop();
  });
  it('never replaces a failed close, nor retries schema incompatibility', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.close.mockRejectedValue(new Error('unsafe drain'));
    await f.recovery.start(f.api, f.workers); f.recovery.degrade();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.recovery.reason).toBe('WORKER_DRAIN_FAILED'); expect(f.leases).toHaveLength(1);
    await expect(f.recovery.stop()).rejects.toThrow('unsafe drain');
    const schema = fixture(); schema.probe.mockRejectedValue(new Error('WORKER_SCHEMA_INCOMPATIBLE'));
    await schema.recovery.start(schema.api, schema.workers); schema.recovery.degrade();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(schema.recovery.reason).toBe('WORKER_SCHEMA_INCOMPATIBLE'); expect(schema.leases).toHaveLength(1);
    await schema.recovery.stop();
  });
  it('serializes slow probes and final shutdown prevents a late probe starting workers', async () => {
    vi.useFakeTimers();
    const f = fixture(); const probe = deferred<boolean>(); f.probe.mockImplementation(() => probe.promise);
    await f.recovery.start(f.api, f.workers); f.recovery.degrade();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.probe).toHaveBeenCalledOnce();
    const stop = f.recovery.stop(); probe.resolve(true); await stop;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.recovery.state).toBe('stopping'); expect(f.workers).toHaveBeenCalledOnce();
  });
  it('retries a database shutdown during generation initialization after draining the partial generation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.workers.mockRejectedValueOnce(Object.assign(new Error('server shutting down'), { code: 'ER_SERVER_SHUTDOWN' }));
    await f.recovery.start(f.api, f.workers);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.recovery.ready).toBe(true);
    expect(f.close).toHaveBeenCalledOnce(); expect(f.workers).toHaveBeenCalledTimes(2);
    expect(f.api).toHaveBeenCalledOnce(); expect(f.maximum()).toBe(1);
    await f.recovery.stop();
  });

  it('safely recovers a bounded renewal timeout without a database restart', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.recovery.start(f.api, f.workers);
    f.leases[0].renew.mockImplementation(async () => { throw new Error('WORKER_LEASE_TIMEOUT'); });
    await expect(f.recovery.assertOwned()).rejects.toThrow('WORKER_LEASE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.recovery.ready).toBe(true); expect(f.maximum()).toBe(1);
    await f.recovery.stop();
  });
});
