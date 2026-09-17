import { expect, it, vi } from 'vitest';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';

it('does not resend a report after external acceptance followed by an audit failure', async () => {
  const registry = new JobRegistry();
  const send = vi.fn(async () => ({ success: true }));
  registerNotificationHandlers(registry, {
    getAlertById: async () => null,
    getChannelById: async () => ({ id: 1, type: 'webhook', enabled: true, config: { webhook_url: 'https://example.test' } }) as any,
    recordDeliveryAttempt: async () => {},
  }, { send, deliverAlertToChannel: async () => {} }, {
    getReportById: async () => ({ id: 1, name: 'report', type: 'health', format: 'html', status: 'completed' }) as any,
    recordNotificationDelivery: async (data) => { if (data.status === 'sent') throw new Error('AUDIT_UNAVAILABLE'); },
  });
  const job = { id: 'job', type: 'report.notify', payload: { reportId: 1, channelId: 1 }, attempts: 1, maxAttempts: 3, fencingToken: 1 };
  await registry.execute(job).catch(() => {});
  await registry.execute({ ...job, attempts: 2, fencingToken: 2 }).catch(() => {});
  expect(send).toHaveBeenCalledTimes(1);
});
