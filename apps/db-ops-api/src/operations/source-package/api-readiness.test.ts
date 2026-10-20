import { afterEach, expect, it, vi } from 'vitest';
import { waitForSourceApi } from './api-readiness.js';

afterEach(() => vi.useRealTimers());

function setup(readyAt = 66_000) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const h = {
    assertActive: vi.fn(async () => {}),
    childRunning: vi.fn(() => true),
    standby: vi.fn(async () => Date.now() >= readyAt),
    health: vi.fn(async () => true),
  };
  return h;
}

it('accepts the owned standby API becoming ready after the former 30-second window', async () => {
  const h = setup();
  const pending = waitForSourceApi(h);
  await vi.advanceTimersByTimeAsync(66_100);
  expect(await pending).toBe(true);
  expect(h.health).toHaveBeenCalled();
});

it('requires the owned standby receipt even if an HTTP endpoint responds', async () => {
  const h = setup(Infinity);
  const pending = waitForSourceApi(h);
  await vi.advanceTimersByTimeAsync(120_100);
  expect(await pending).toBe(false);
  expect(h.health).not.toHaveBeenCalled();
});

it('stops at the bounded startup timeout', async () => {
  const h = setup(0);
  h.health.mockResolvedValue(false);
  const pending = waitForSourceApi(h);
  await vi.advanceTimersByTimeAsync(120_100);
  expect(await pending).toBe(false);
  const calls = h.assertActive.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.assertActive).toHaveBeenCalledTimes(calls);
});

it('does not probe an exited owned child', async () => {
  const h = setup(0);
  h.childRunning.mockReturnValue(false);
  expect(await waitForSourceApi(h)).toBe(false);
  expect(h.health).not.toHaveBeenCalled();
});

it.each(['lease lost', 'operation deadline expired', 'cancelled'])('preserves rejection when %s', async (reason) => {
  const h = setup();
  h.assertActive.mockImplementation(async () => {
    if (Date.now() >= 1_000) throw Error(reason);
  });
  const pending = expect(waitForSourceApi(h)).rejects.toThrow(reason);
  await vi.advanceTimersByTimeAsync(1_100);
  await pending;
  expect(h.health).not.toHaveBeenCalled();
});
