import type { PoolConnection, RowDataPacket } from "mysql2/promise";
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
    "SELECT id,level,created_at FROM alerts WHERE id=?",
    [alertId],
  );
  if (!alerts.length) throw Error("NOTIFICATION_ALERT_MISSING");
  const [rows] = await c.execute<RowDataPacket[]>(
    "SELECT * FROM notification_channels WHERE enabled=1",
  );
  // Persist recovery even while the original is pending/unknown. The sole queue
  // claims it only after that original is confirmed sent (also after restart).
  const channels = [];
  for (const row of rows) {
    if (transition.phase === "recovery") {
      const [original] = await c.execute<RowDataPacket[]>(
        "SELECT id FROM workflow_jobs WHERE job_type='notification.deliver' AND idempotency_key=? UNION ALL SELECT workflow_job_id FROM notification_delivery_states WHERE business_key=? AND state='sent'",
        [`notification:${alertId}:${row.id}`, `notification:${alertId}:${row.id}`],
      );
      if (!original.length) continue;
    }
    channels.push({
      ...row,
      config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    });
  }
  return new NotificationDispatchScheduler(
    {
      getPendingAlerts: async () => [{ ...alerts[0], transition }] as any,
      getEnabledChannels: async () => channels as any,
    },
    // Recovery follows recipients of the original problem, even if their
    // severity threshold changed since then. New channels receive no recovery.
    { routeAlert: (a, cs) => transition.phase === 'recovery' ? cs : notificationService.routeAlert(a as any, cs as any) },
    new MysqlWorkflowStore(() => c as any),
  ).enqueuePending();
}
