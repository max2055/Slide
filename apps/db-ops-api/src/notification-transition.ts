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
  // Do not emit an orphan recovery to a recipient that never received the problem.
  const channels = [];
  for (const row of rows) {
    if (transition.phase === "recovery") {
      const [sent] = await c.execute<RowDataPacket[]>(
        "SELECT business_key FROM notification_delivery_states WHERE business_key=? AND state='sent'",
        [`notification:${alertId}:${row.id}`],
      );
      if (!sent.length) continue;
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
    { routeAlert: (a, cs) => notificationService.routeAlert(a as any, cs as any) },
    new MysqlWorkflowStore(() => c as any),
  ).enqueuePending();
}
