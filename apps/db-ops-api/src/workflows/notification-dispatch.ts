import { randomUUID } from 'node:crypto';
import type { WorkflowJobInput } from './worker-runtime.js';

type PendingAlert = { id: number; level: string; created_at?: Date | string };
type Channel = { id: number; delivery_start_at?: Date | string | null };

/** A newly enabled channel must not replay alerts that existed before activation. */
export function isAlertEligibleForChannel(alert: PendingAlert, channel: Channel): boolean {
  if (!channel.delivery_start_at || !alert.created_at) return true;
  const alertCreatedAt = new Date(alert.created_at).getTime();
  const deliveryStartAt = new Date(channel.delivery_start_at).getTime();
  return !Number.isNaN(alertCreatedAt) && !Number.isNaN(deliveryStartAt) && alertCreatedAt >= deliveryStartAt;
}

export interface NotificationSource {
  getPendingAlerts(): Promise<PendingAlert[]>;
  getEnabledChannels(): Promise<Channel[]>;
  hasSuccessfulDelivery?(alertId: number, channelId: number): Promise<boolean>;
}

export interface NotificationRouter {
  routeAlert(alert: PendingAlert, channels: Channel[]): Channel[];
}

export interface WorkflowEnqueuer {
  enqueue(job: WorkflowJobInput): Promise<void>;
}

export function createNotificationDispatchJob(availableAt = new Date()): WorkflowJobInput {
  const slot = Math.floor(availableAt.getTime() / 10_000);
  return {
    id: `notification-dispatch-${slot}`,
    type: 'notification.dispatch',
    schemaVersion: 1,
    payload: {},
    idempotencyKey: `notification-dispatch:${slot}`,
    maxAttempts: 5,
    availableAt,
  };
}

export class NotificationDispatchScheduler {
  constructor(
    private readonly source: NotificationSource,
    private readonly router: NotificationRouter,
    private readonly workflow: WorkflowEnqueuer,
    private readonly newId: () => string = randomUUID,
  ) {}

  async enqueuePending(): Promise<number> {
    const [alerts, channels] = await Promise.all([
      this.source.getPendingAlerts(),
      this.source.getEnabledChannels(),
    ]);
    let enqueued = 0;
    for (const alert of alerts) {
      for (const channel of this.router.routeAlert(alert, channels)) {
        if (!isAlertEligibleForChannel(alert, channel)) continue;
        if (await this.source.hasSuccessfulDelivery?.(alert.id, channel.id)) continue;
        await this.workflow.enqueue({
          id: this.newId(),
          type: 'notification.deliver',
          schemaVersion: 1,
          payload: { alertId: alert.id, channelId: channel.id },
          idempotencyKey: `notification:${alert.id}:${channel.id}`,
          maxAttempts: 5,
        });
        enqueued++;
      }
    }
    return enqueued;
  }
}
