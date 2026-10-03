import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerStartup } from './worker-startup.js';

afterEach(() => vi.useRealTimers());
function setup(acquired = true) {
  const lease = { acquire: vi.fn(async () => acquired), renew: vi.fn(async () => true), release: vi.fn(async () => {}) };
  const close = vi.fn(async () => {});
  const startup = new WorkerStartup(lease, close);
  return { lease, close, startup };
}
describe('startup lease lifecycle', () => {
  it('renews before initialization and keeps ownership throughout a 45 second startup', async () => {
    vi.useFakeTimers();
    const { lease, startup } = setup();
    const start = startup.start(async () => { expect(lease.renew).toHaveBeenCalled(); }, async () => {
      await startup.step(() => new Promise(resolve => setTimeout(resolve, 45_000)));
      await startup.assertOwned();
    });
    await vi.advanceTimersByTimeAsync(46_000);
    await start;
    expect(lease.renew.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(startup.ready).toBe(true);
    await startup.stop();
  });
  it('initializes API dependencies on standby without starting workers or electing again', async () => {
    vi.useFakeTimers();
    const { startup, lease } = setup(false);
    const api = vi.fn(async () => {}), workers = vi.fn(async () => {});
    await startup.start(api, workers);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(api).toHaveBeenCalledOnce(); expect(workers).not.toHaveBeenCalled();
    expect(startup.ready).toBe(false); expect(lease.acquire).toHaveBeenCalledOnce();
    await startup.stop(); expect(lease.release).not.toHaveBeenCalled();
  });
  for (const failure of ['lost', 'error', 'blocked']) {
    it(`cancels slow initialization and closes resources when renewal is ${failure}`, async () => {
      vi.useFakeTimers();
      const { startup, lease, close } = setup();
      const sideEffect = vi.fn();
      const start = startup.start(async () => {}, async () => {
        await startup.step(() => new Promise(resolve => setTimeout(resolve, 45_000)));
        sideEffect();
      });
      const failed = expect(start).rejects.toThrow('WORKER_LEASE');
      await vi.advanceTimersByTimeAsync(1);
      if (failure === 'lost') lease.renew.mockResolvedValue(false);
      if (failure === 'error') lease.renew.mockRejectedValue(new Error('secret transport detail'));
      if (failure === 'blocked') lease.renew.mockImplementation(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(16_000);
      await failed;
      expect(startup.signal.aborted).toBe(true); expect(startup.ready).toBe(false);
      expect(close).toHaveBeenCalledOnce(); expect(sideEffect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sideEffect).not.toHaveBeenCalled();
      expect(lease.renew.mock.calls.length).toBe(2);
    });
  }
  it('closes a resource that arrives after cancellation and does not continue initialization', async () => {
    vi.useFakeTimers();
    const { startup, close } = setup();
    const dispose = vi.fn(async () => {});
    const start = startup.start(async () => {}, () => startup.step(
      () => new Promise<{ dispose: typeof dispose }>(resolve => setTimeout(() => resolve({ dispose }), 20_000)),
      resource => resource.dispose(),
    ).then(() => {}));
    const failed = expect(start).rejects.toThrow('WORKER_STOPPED');
    await vi.advanceTimersByTimeAsync(1); await startup.stop();
    await failed; await vi.advanceTimersByTimeAsync(21_000);
    expect(close).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  });
  it('closes partially initialized resources on initialization failure', async () => {
    const { startup, close, lease } = setup();
    await expect(startup.start(async () => {}, async () => { throw new Error('INIT_FAILED'); })).rejects.toThrow('INIT_FAILED');
    expect(close).toHaveBeenCalledOnce(); expect(startup.ready).toBe(false); expect(lease.release).toHaveBeenCalledOnce();
  });
});
