import { expect, it, vi } from 'vitest';
import { installPlatformRuntimeObservation } from './platform-runtime.js';
it('sends only coarse event types, bounds bursts, and stops after disposal', async () => {
  const target = new EventTarget(); const send = vi.fn(async (_body: unknown) => {});
  const dispose = installPlatformRuntimeObservation(target, send, () => true, 'unknown');
  target.dispatchEvent(new ErrorEvent('error', { message: 'private message' }));
  target.dispatchEvent(new ErrorEvent('error', { message: 'second private message' }));
  expect(send.mock.calls.map(call => call[0])).toEqual([{ eventType: 'boot.completed', buildId: 'unknown' }, { eventType: 'runtime.error', buildId: 'unknown' }]);
  expect(JSON.stringify(send.mock.calls)).not.toContain('private');
  dispose(); target.dispatchEvent(new Event('unhandledrejection'));
  expect(send).toHaveBeenCalledTimes(2);
});
it('never sends unauthenticated data or retries failed telemetry', async () => {
  const target = new EventTarget(); const send = vi.fn(async () => { throw new Error('offline'); });
  let authenticated = false;
  const dispose = installPlatformRuntimeObservation(target, send, () => authenticated, 'unknown');
  target.dispatchEvent(new Event('error')); expect(send).not.toHaveBeenCalled();
  authenticated = true; target.dispatchEvent(new Event('slide-permissions-loaded'));
  await Promise.resolve(); await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1); dispose();
});
