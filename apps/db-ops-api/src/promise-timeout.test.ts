import { describe, expect, it, vi } from 'vitest';
import { withTimeout } from './promise-timeout.js';

describe('withTimeout', () => {
  it('returns an operation that completes before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 20, 'late')).resolves.toBe('ok');
  });

  it('rejects at the deadline and disposes a late result', async () => {
    vi.useFakeTimers();
    let resolveOperation!: (value: { close: () => void }) => void;
    const close = vi.fn();
    const operation = new Promise<{ close: () => void }>((resolve) => { resolveOperation = resolve; });
    const result = withTimeout(operation, 5_000, 'connection timed out', (value) => value.close());

    const rejection = expect(result).rejects.toThrow('connection timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    resolveOperation({ close });
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
