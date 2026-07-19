import { describe, expect, it } from 'vitest';
import { createNotificationDispatchJob, NotificationDispatchScheduler } from './notification-dispatch.js';

describe('NotificationDispatchScheduler', () => {
  it('uses one idempotency key per durable ten-second dispatch slot', () => {
    const first = createNotificationDispatchJob(new Date('2026-07-19T00:00:01.000Z'));
    const restart = createNotificationDispatchJob(new Date('2026-07-19T00:00:09.999Z'));
    const next = createNotificationDispatchJob(new Date('2026-07-19T00:00:10.000Z'));

    expect(restart).toMatchObject({ id: first.id, idempotencyKey: first.idempotencyKey, type: 'notification.dispatch' });
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(next.availableAt).toEqual(new Date('2026-07-19T00:00:10.000Z'));
  });

  it('creates one idempotent delivery job per matched alert and channel', async () => {
    const jobs: any[] = [];
    const scheduler = new NotificationDispatchScheduler(
      { getPendingAlerts: async () => [{ id: 7, level: 'critical' }] as any, getEnabledChannels: async () => [{ id: 2 }, { id: 3 }] as any },
      { routeAlert: () => [{ id: 2 }, { id: 3 }] } as any,
      { enqueue: async (job: any) => { jobs.push(job); } },
      () => 'job-id',
    );

    await scheduler.enqueuePending();

    expect(jobs).toEqual([
      expect.objectContaining({ type: 'notification.deliver', payload: { alertId: 7, channelId: 2 }, idempotencyKey: 'notification:7:2' }),
      expect.objectContaining({ type: 'notification.deliver', payload: { alertId: 7, channelId: 3 }, idempotencyKey: 'notification:7:3' }),
    ]);
  });

  it('does not let one successful channel suppress another channel delivery', async () => {
    const jobs: any[] = [];
    const scheduler = new NotificationDispatchScheduler(
      {
        getPendingAlerts: async () => [{ id: 7, level: 'critical' }] as any,
        getEnabledChannels: async () => [{ id: 2 }, { id: 3 }] as any,
        hasSuccessfulDelivery: async (_alertId, channelId) => channelId === 2,
      },
      { routeAlert: () => [{ id: 2 }, { id: 3 }] } as any,
      { enqueue: async (job: any) => { jobs.push(job); } },
      () => 'job-id',
    );

    await scheduler.enqueuePending();

    expect(jobs).toEqual([expect.objectContaining({
      payload: { alertId: 7, channelId: 3 },
      idempotencyKey: 'notification:7:3',
    })]);
  });
});
