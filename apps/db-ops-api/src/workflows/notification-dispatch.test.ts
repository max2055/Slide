import { describe, expect, it, vi } from 'vitest';
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

  it('does not enqueue an alert that predates a channel activation boundary', async () => {
    const jobs: any[] = [];
    const scheduler = new NotificationDispatchScheduler(
      {
        getPendingAlerts: async () => [{ id: 7, level: 'critical', created_at: new Date('2026-07-19T00:00:00.000Z') }] as any,
        getEnabledChannels: async () => [{ id: 2, delivery_start_at: new Date('2026-07-19T00:01:00.000Z') }] as any,
      },
      { routeAlert: (_alert: any, channels: any[]) => channels } as any,
      { enqueue: async (job: any) => { jobs.push(job); } },
      () => 'job-id',
    );

    await scheduler.enqueuePending();

    expect(jobs).toEqual([]);
  });
});

// #396: independent repair cannot inherit the exhausted job's retry budget.
describe('NotificationDispatchReconciler', () => {
  it('recovers after five failed writes, coalesces overlap and reconciles a restart by slot key', async () => {
    const { NotificationDispatchReconciler } = await import('./notification-dispatch.js');
    const enqueue = vi.fn().mockRejectedValue(new Error('STORE_UNAVAILABLE'));
    const repair = new NotificationDispatchReconciler({ enqueue });
    const signal = new AbortController().signal;
    for (let i = 0; i < 5; i++) await expect(repair.ensure(signal, new Date(20_000))).rejects.toThrow('STORE_UNAVAILABLE');
    let release!: () => void;
    enqueue.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = repair.ensure(signal, new Date(20_000));
    const overlap = repair.ensure(signal, new Date(20_000));
    expect(overlap).toBe(first);
    release(); await first;
    await repair.ensure(signal, new Date(20_001));
    expect(enqueue).toHaveBeenCalledTimes(6);
    enqueue.mockResolvedValue(undefined);
    await new NotificationDispatchReconciler({ enqueue }).ensure(signal, new Date(20_002));
    expect(enqueue.mock.calls.at(-1)![0].idempotencyKey).toBe('notification-dispatch:2');
    const abort = new AbortController(); abort.abort();
    expect(() => repair.ensure(abort.signal, new Date(30_000))).toThrow();
    expect(enqueue).toHaveBeenCalledTimes(7);
  });
});

it('does not cache a cancelled in-flight repair as successful (#396)', async () => {
  const { NotificationDispatchReconciler } = await import('./notification-dispatch.js');
  let release!: () => void;
  const enqueue = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const repair = new NotificationDispatchReconciler({ enqueue });
  const controller = new AbortController();
  const running = repair.ensure(controller.signal, new Date(20_000));
  controller.abort(new Error('LEADER_STOPPED')); release();
  await expect(running).rejects.toThrow('LEADER_STOPPED');
  await repair.ensure(new AbortController().signal, new Date(20_000));
  expect(enqueue).toHaveBeenCalledTimes(2);
  expect(enqueue.mock.calls[0][0].idempotencyKey).toBe(enqueue.mock.calls[1][0].idempotencyKey);
});
