import { AsyncLocalStorage } from 'node:async_hooks';

const tails = new Map<number, Promise<void>>();
const held = new AsyncLocalStorage<Set<number>>();

/**
 * One owner at a time for a shared database session.
 * Re-entrant on the same async call so a health probe issued by the owner
 * does not wait for itself. A different request waits until the owner finishes.
 */
export function withInstanceExecutionLock<T>(instanceId: number, action: () => Promise<T>): Promise<T> {
  const current = held.getStore();
  if (current?.has(instanceId)) return action();

  const previous = tails.get(instanceId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  tails.set(instanceId, queued);

  return previous.catch(() => undefined).then(async () => {
    const next = new Set(held.getStore());
    next.add(instanceId);
    try {
      return await held.run(next, action);
    } finally {
      release();
      if (tails.get(instanceId) === queued) tails.delete(instanceId);
    }
  });
}
