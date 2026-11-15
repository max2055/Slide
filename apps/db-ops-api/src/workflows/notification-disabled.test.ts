import { expect, it, vi } from 'vitest';
import type { DeliveryGate, DeliveryRequest } from './delivery-store.js';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';

it.each(['notification.deliver', 'report.notify'])('%s suppresses a disabled frozen snapshot without acquiring or sending (#629)', async type => {
  const request = { channel: { id: 1, enabled: true }, message: {} } as DeliveryRequest;
  const gate: DeliveryGate = {
    snapshot: vi.fn(async () => request), skipDisabled: vi.fn(async () => {}),
    acquire: vi.fn(), finish: vi.fn(), preflightFailed: vi.fn(),
  };
  const channel = vi.fn(async () => ({ id: 1, enabled: false }) as any);
  const send = vi.fn();
  const registry = new JobRegistry();
  registerNotificationHandlers(registry, { getAlertById: vi.fn(), getChannelById: channel },
    { send, buildMessage: vi.fn() }, { getReportById: vi.fn() }, gate);
  const job = { id: 'frozen', type, payload: { alertId: 1, reportId: 1, channelId: 1 }, attempts: 2, maxAttempts: 5, fencingToken: 2 };
  const context = { workerId: 'worker', fencingToken: 2, signal: new AbortController().signal };
  await expect(registry.execute(job, context)).resolves.toBeUndefined();
  expect(gate.skipDisabled).toHaveBeenCalledWith(job, context);
  expect(gate.acquire).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  // Failed terminal writes must be observable/retryable, never silently completed.
  vi.mocked(gate.skipDisabled).mockRejectedValueOnce(new Error('STORE_UNAVAILABLE'));
  await expect(registry.execute(job, context)).rejects.toThrow('STORE_UNAVAILABLE');
  channel.mockRejectedValueOnce(new Error('CHANNEL_QUERY_UNAVAILABLE'));
  await expect(registry.execute(job, context)).rejects.toThrow('CHANNEL_QUERY_UNAVAILABLE');
  expect(gate.skipDisabled).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();
});
