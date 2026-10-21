import { afterEach, expect, it, vi } from 'vitest';
import { ServiceRecovery } from './service-recovery.js';
afterEach(() => vi.useRealTimers());
it('merges outage reports, backs off, emits recovery once and stops healthy polling', async () => {
  vi.useFakeTimers();
  const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const recovered = vi.fn(); const recovery = new ServiceRecovery(probe, recovered);
  recovery.retain(); recovery.retain();
  for (let i = 0; i < 30; i++) recovery.unavailable();
  await vi.advanceTimersByTimeAsync(1_000); expect(probe).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2_000); expect(probe).toHaveBeenCalledTimes(2);
  expect(recovered).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(90_000); expect(probe).toHaveBeenCalledTimes(2);
  recovery.release(); recovery.release();
});
it('aborts a probe after timeout, never overlaps a stalled transport, and cleans up on final unmount', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal, finish!: (value: boolean) => void;
  const probe = vi.fn((s: AbortSignal) => { signal = s; return new Promise<boolean>(resolve => { finish = resolve; }); });
  const recovered = vi.fn(); const recovery = new ServiceRecovery(probe, recovered);
  recovery.retain(); recovery.unavailable();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(probe).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(true);
  recovery.release(); finish(true); await vi.advanceTimersByTimeAsync(90_000);
  expect(recovered).not.toHaveBeenCalled(); expect(probe).toHaveBeenCalledOnce();
});
it('resumes a failed read probe when the page becomes visible without retaining any write', async () => {
  vi.useFakeTimers(); const probe = vi.fn(async () => false), recovered = vi.fn();
  const recovery = new ServiceRecovery(probe, recovered);
  recovery.retain(); recovery.unavailable(); await vi.advanceTimersByTimeAsync(1_000);
  recovery.visible(); await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(2); recovery.release();
  await vi.advanceTimersByTimeAsync(90_000); expect(probe).toHaveBeenCalledTimes(2);
});
