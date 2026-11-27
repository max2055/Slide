import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { manualSilenceBlocksNotification } from "./alert-silence-service.js";
import { notificationService } from "./notification-service.js";
import {
  NotificationDispatchScheduler,
  type NotificationTransition,
} from "./workflows/notification-dispatch.js";
import { MysqlWorkflowStore } from "./workflows/worker-runtime.js";
/** Caller owns the alert mutation transaction; reuse the sole scheduler and sender. */
export async function enqueueNotificationTransition(
  c: PoolConnection,
  alertId: number,
  transition: NotificationTransition,
) {
  const [alerts] = await c.execute<RowDataPacket[]>(
    "SELECT id,level,created_at,source,instance_id,metric_name,tags->>'$.manual_silence_suppressed' AS manual_silence_suppressed FROM alerts WHERE id=?",
    [alertId],
  );
  if (!alerts.length) throw Error("NOTIFICATION_ALERT_MISSING");
  const alert = alerts[0];
  if (alert.source === "template-trigger" && alert.instance_id && alert.metric_name) {
    if (alert.manual_silence_suppressed === "true") return 0;
    // The transition and its evidence still commit when suppression is unknown.
    try {
      if (await manualSilenceBlocksNotification(c, Number(alert.instance_id), alert.metric_name, new Date(transition.at))) return 0;
    } catch { return 0; }
  }
  const [rows] = await c.execute<RowDataPacket[]>(
    "SELECT * FROM notification_channels WHERE enabled=1",
  );
  // Persist recovery even while the original is pending/unknown. The sole queue
  // claims it only after that original is confirmed sent (also after restart).
  const channels = [];
  for (const row of rows) {
    if (transition.phase === "recovery") {
      const originalKey = `notification:${alertId}:${row.id}`;
      // Match the sender's lock order. A recovery cannot enqueue from a stale
      // snapshot after the sender settles the original and its queued recovery.
      const [original] = await c.execute<RowDataPacket[]>(
        "SELECT id FROM workflow_jobs WHERE job_type='notification.deliver' AND idempotency_key=? FOR UPDATE",
        [originalKey],
      );
      const [deliveries] = await c.execute<RowDataPacket[]>(
        'SELECT state,error_code FROM notification_delivery_states WHERE business_key=? FOR UPDATE',
        [originalKey],
      );
      const delivery = deliveries[0];
      if (delivery?.state === 'skipped' && delivery.error_code === 'MANUAL_SILENCE_SUPPRESSED') continue;
      if (!original.length && delivery?.state !== 'sent') continue;
    }
    channels.push({
      ...row,
      config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    });
  }
  return new NotificationDispatchScheduler(
    {
      getPendingAlerts: async () => [{ ...alert, transition }] as any,
      getEnabledChannels: async () => channels as any,
    },
    // Recovery follows recipients of the original problem, even if their
    // severity threshold changed since then. New channels receive no recovery.
    { routeAlert: (a, cs) => transition.phase === 'recovery' ? cs : notificationService.routeAlert(a as any, cs as any) },
    new MysqlWorkflowStore(() => c as any),
  ).enqueuePending();
}
