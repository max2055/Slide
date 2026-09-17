import { expect, it, vi } from 'vitest';
import { testDeliveryGate } from './delivery-test-gate.js';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';

it('does not resend a report after external acceptance followed by an audit failure', async () => {
  const registry = new JobRegistry();
  const send = vi.fn(async () => ({ success: true }));
  const gate = testDeliveryGate();
  const finish = gate.finish;
  gate.finish = async (job, context, claim, state, error) => {
    if (state === 'sent') throw new Error('AUDIT_UNAVAILABLE');
    return finish(job, context, claim, state, error);
  };
  registerNotificationHandlers(registry, {
    getAlertById: async () => null,
    getChannelById: async () => ({ id: 1, type: 'webhook', enabled: true, config: { webhook_url: 'https://example.test' } }) as any,
  }, { send, buildMessage: () => ({}) }, {
    getReportById: async () => ({ id: 1, name: 'report', type: 'health', format: 'html', status: 'completed' }) as any,
  }, gate);
  const job = { id: 'job', type: 'report.notify', payload: { reportId: 1, channelId: 1 }, attempts: 1, maxAttempts: 3, fencingToken: 1 };
  await registry.execute(job).catch(() => {});
  await registry.execute({ ...job, attempts: 2, fencingToken: 2 }).catch(() => {});
  expect(send).toHaveBeenCalledTimes(1);
});
