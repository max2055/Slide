import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { CronRunTracker } from './cron-run-tracker.js';

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const storageKey = 'slide:cron-runs:session';
const saved = { jobId: 42, requestKey: 'original-key', status: 'unconfirmed' };
let tracker: CronRunTracker;
let changed: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); authFetch.mockReset();
  localStorage.setItem(storageKey, JSON.stringify([saved]));
  changed = vi.fn(); tracker = new CronRunTracker(changed); tracker.start();
});
afterEach(() => { tracker.stop(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('OCR-0377 / #422 request ownership', () => {
  it('clears the restored timer before POST, prevents overlapping GET and aborts POST on stop', async () => {
    const post = deferred<any>(); authFetch.mockReturnValueOnce(post.promise);
    const pending = tracker.trigger(42);
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch).toHaveBeenCalledTimes(1);
    const options = authFetch.mock.calls[0][1];
    expect(options.headers).toEqual({ 'Idempotency-Key': 'original-key' });
    tracker.stop(); expect(options.signal.aborted).toBe(true);
    const cache = localStorage.getItem(storageKey); changed.mockClear();
    post.resolve(response({ jobId: 42, runId: 'late', status: 'succeeded' })); await pending;
    expect(tracker.runs.get(42)).toEqual(saved);
    expect(localStorage.getItem(storageKey)).toBe(cache);
    expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one observer per job while allowing different jobs and aborts all on exit', async () => {
    const get = deferred<any>(); const post = deferred<any>();
    authFetch.mockReturnValueOnce(get.promise).mockReturnValueOnce(post.promise);
    await vi.advanceTimersByTimeAsync(3000);
    await tracker.trigger(42);
    const pending = tracker.trigger(43);
    expect(authFetch).toHaveBeenCalledTimes(2);
    tracker.stop();
    expect(authFetch.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
    get.resolve(response({ jobId: 42, runId: 'late', status: 'running' }));
    post.resolve(response({ jobId: 43, runId: 'late-43', status: 'queued' })); await pending;
  });

  it.each(['success', 'denial', 'body-error'] as const)('ignores a stale POST %s across stop/start, including its cleanup', async (kind) => {
    const body = deferred<any>(); const fresh = deferred<any>();
    authFetch.mockResolvedValueOnce({ ok: kind !== 'denial', status: kind === 'denial' ? 403 : 202, json: () => body.promise });
    const pending = tracker.trigger(42); await Promise.resolve();
    tracker.stop(); tracker.start();
    authFetch.mockReturnValueOnce(fresh.promise);
    const current = tracker.trigger(42);
    if (kind === 'body-error') body.reject(new Error('old body failed'));
    else body.resolve(kind === 'denial' ? { error: 'old denial' } : { jobId: 42, runId: 'old', status: 'succeeded' });
    await pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(3000);
    await tracker.trigger(42);
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(tracker.runs.get(42)).toEqual(saved);
    tracker.stop(); expect(authFetch.mock.calls[1][1].signal.aborted).toBe(true);
    fresh.resolve(response({ jobId: 42, runId: 'fresh', status: 'queued' })); await current;
  });

  it.each(['success', 'failure'] as const)('ignores a stale GET %s after restart without releasing the newer POST', async (kind) => {
    const old = deferred<any>(); authFetch.mockReturnValueOnce(old.promise);
    await vi.advanceTimersByTimeAsync(3000);
    tracker.stop(); tracker.start();
    const fresh = deferred<any>(); authFetch.mockReturnValueOnce(fresh.promise);
    const current = tracker.trigger(42);
    if (kind === 'success') old.resolve(response({ jobId: 42, runId: 'old', status: 'succeeded' }));
    else old.reject(new Error('late offline'));
    await vi.advanceTimersByTimeAsync(3000);
    await tracker.trigger(42);
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(tracker.runs.get(42)).toEqual(saved);
    fresh.resolve(response({ jobId: 42, runId: 'fresh', status: 'queued' })); await current;
    expect(tracker.runs.get(42)?.runId).toBe('fresh');
  });

  it('reconciles an unknown POST with the original key without automatically resubmitting', async () => {
    authFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(tracker.trigger(42)).rejects.toThrow('offline');
    expect(tracker.runs.get(42)).toEqual(saved);
    authFetch.mockResolvedValueOnce(response({ jobId: 42, runId: 'original-run', status: 'succeeded' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch.mock.calls[1][0]).toBe('/api/cron/jobs/42/runs?requestKey=original-key');
    expect(tracker.runs.get(42)).toMatchObject({ requestKey: 'original-key', runId: 'original-run', status: 'succeeded' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(authFetch).toHaveBeenCalledTimes(2);
  });
});
