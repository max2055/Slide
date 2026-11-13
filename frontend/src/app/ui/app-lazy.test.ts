import { describe, expect, it, vi } from 'vitest';
import { createLazy } from './app-render.ts';
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

describe('MAX-648 / #411 lazy module recovery', () => {
  it('caches success and shares an in-flight request across renders', async () => {
    const module = { loaded: true };
    const loader = vi.fn().mockResolvedValue(module);
    const view = createLazy(loader);
    expect(view.read()).toBeNull();
    expect(view.read()).toBeNull();
    await settle();
    expect(view.read()).toBe(module);
    view.retry();
    expect(view.read()).toBe(module);
    expect(loader).toHaveBeenCalledOnce();
  });
  it('stops after first and repeated failures until explicit retry, then caches success', async () => {
    const module = { loaded: true };
    const loader = vi.fn().mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure')).mockResolvedValue(module);
    const view = createLazy(loader);
    view.read(); await settle();
    expect(view.failed).toBe(true);
    for (let i = 0; i < 10; i++) expect(view.read()).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    view.retry(); view.retry(); await settle();
    expect(view.failed).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
    view.retry(); await settle();
    expect(view.failed).toBe(false);
    expect(view.read()).toBe(module);
    expect(loader).toHaveBeenCalledTimes(3);
  });
  it('handles synchronous exceptions and failures after another view is selected', async () => {
    let reject!: (reason: Error) => void;
    const abandoned = createLazy(() => new Promise((_, fail) => { reject = fail; }));
    const active = createLazy(async () => ({ view: 'active' }));
    abandoned.read(); active.read(); await settle();
    reject(new Error('late failure')); await settle();
    expect(abandoned.failed).toBe(true);
    expect(active.read()).toEqual({ view: 'active' });
    const synchronous = createLazy(() => { throw new Error('sync failure'); });
    expect(() => synchronous.read()).not.toThrow(); await settle();
    expect(synchronous.failed).toBe(true);
  });
});
