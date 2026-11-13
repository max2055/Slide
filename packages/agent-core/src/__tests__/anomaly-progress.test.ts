import { expect, it } from 'vitest';
import { AnomalyGuard } from '../runtime/anomaly-guard.js';
import { progressValue } from '../runtime/progress-evidence.js';

it('MAX-469: advances beyond 256 evidence entries and still detects real stagnation', () => {
  const guard = new AnomalyGuard();
  const text = 'The inspection found several active transactions with distinct owners and waiting queries. We should compare their lock dependencies before choosing the next diagnostic action.';
  let epoch = guard.progress(Array.from({ length: 256 }, (_, n) => ({ n })));
  expect(epoch).toBe(256);
  expect(guard.inspect(text, '', epoch).stalled).toBe(false);
  epoch = guard.progress([{ n: 256 }]);
  expect(epoch).toBe(257);
  expect(guard.inspect(text, '', epoch).stalled).toBe(false);
  for (let n = 257; n < 600; n++) expect(guard.progress([{ n }])).toBe(n + 1);
  expect(guard.progress([{ n: 598 }, { n: 599 }])).toBe(600);
  expect(guard.inspect(text, '', 600).stalled).toBe(false);
  expect(guard.inspect(text, '', 600).stalled).toBe(true);
  // FIFO window: only the last 256 distinct hashes are remembered.
  expect(guard.progress([{ n: 0 }])).toBe(601);
  expect(guard.progress([{ n: 0 }])).toBe(601);
});

it('MAX-470: bounds traversal and representation and avoids executable serializers', () => {
  let invoked = false;
  const value = { secret: 'x'.repeat(200_000), toJSON() { invoked = true; throw new Error('private detail'); } };
  expect(progressValue(value).length).toBeLessThanOrEqual(100_000);
  expect(invoked).toBe(false);
  const tree: unknown[] = [];
  let child = tree;
  for (let i = 0; i < 100; i++) { const next: unknown[] = []; child.push(next); child = next; }
  expect(progressValue(tree)).toContain('[limit]');
  const proxy = new Proxy({}, { ownKeys() { throw new Error('private detail'); } });
  expect(progressValue(proxy)).toContain('[unreadable]');
  expect(progressValue(proxy)).not.toContain('private detail');
  expect(progressValue({ b: 2, a: 1 })).toBe(progressValue({ a: 1, b: 2 }));
  expect(progressValue(1n)).not.toBe(progressValue('bigint:1'));
});

it('MAX-470: unknown values use stable bounded evidence without throwing', () => {
  const guard = new AnomalyGuard();
  const cycle: Record<string, unknown> = { value: 1 }; cycle.self = cycle;
  const equivalent: Record<string, unknown> = { value: 1 }; equivalent.self = equivalent;
  expect(guard.progress([1n, cycle, undefined])).toBe(3);
  expect(guard.progress([1n, equivalent, undefined])).toBe(3);
  expect(guard.progress([2n, { value: 2 }])).toBe(5);
  const throwing = { get value() { throw new Error('private detail'); } };
  expect(() => guard.progress([throwing])).not.toThrow();
  expect(guard.progress([throwing])).toBe(6);
});
