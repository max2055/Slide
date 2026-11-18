import { describe, expect, it, vi } from 'vitest';
import { drainWorkers, type WorkerDrainEvent } from './drain-workers.js';

describe('MAX-681 worker drain diagnostics', () => {
  it('identifies synchronous and asynchronous failures while awaiting every consumer', async () => {
    const events: WorkerDrainEvent[] = [];
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const secret = new Error('driver error containing a password');
    const stop = drainWorkers([
      { name: 'alerts', stop: () => { throw secret; } },
      { name: 'metrics', stop: async () => { throw secret; } },
      { name: 'workflow', stop: () => pending },
    ], event => events.push(event));
    const settled = vi.fn();
    const result = stop.catch(error => { settled(); return error; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(events.filter(event => event.state === 'failed').map(event => event.consumer)).toEqual(['alerts', 'metrics']);
    finish();
    expect((await result).message).toBe('WORKER_DRAIN_FAILED');
    expect(events).toContainEqual({ consumer: 'workflow', state: 'drained' });
    expect(JSON.stringify(events)).not.toContain(secret.message);
  });

  it('does not let a failed observer interrupt cleanup or mask its failure', async () => {
    const stop = vi.fn(async () => {});
    await expect(drainWorkers([{ name: 'workflow', stop }], () => { throw new Error('observer'); })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    await expect(drainWorkers([{ name: 'workflow', stop: async () => { throw new Error('driver'); } }], () => {})).rejects.toThrow('WORKER_DRAIN_FAILED');
  });
});
