import { maintenanceBlocksDelivery } from '../maintenance-notification.js';
import type { JobRegistry } from './job-registry.js';
import type { notificationDatabaseService as NotificationDatabase } from '../notification-database-service.js';
import type { NotificationService } from '../notification-service.js';
import type { reportDatabaseService as ReportDatabase } from '../report-database-service.js';
import { validateNotificationChannelConfig } from '../notification-channel-config.js';
import { isAlertEligibleForChannel } from './notification-dispatch.js';
import { deliveryIdentity, deliveryStore, type DeliveryGate, type DeliveryRequest } from './delivery-store.js';
import { parseRolloutAlertFence, rolloutAlertPublicationGate,
  type RolloutAlertPublicationGate } from '../metrics/rollout/alert-publication-fence.js';

/** All durable external effects pass through the business gate, including replay. */
export function registerNotificationHandlers(
  registry: JobRegistry,
  notificationDatabaseService: Pick<typeof NotificationDatabase, 'getAlertById' | 'getChannelById'>,
  notificationService: Pick<NotificationService, 'send' | 'buildMessage'>,
  reportDatabaseService: Pick<typeof ReportDatabase, 'getReportById'>,
  gate: DeliveryGate = deliveryStore,
  publicationGate: RolloutAlertPublicationGate = rolloutAlertPublicationGate,
): void {
  for (const type of ['notification.deliver', 'report.notify']) {
    registry.register(type, async (_payload, job, context) => {
      const { signal } = context;
      const identity = deliveryIdentity(job);
      signal.throwIfAborted();
      let request: DeliveryRequest | null = await gate.snapshot(identity.key);
      if (request) {
        const currentChannel = await notificationDatabaseService.getChannelById(identity.channelId);
        signal.throwIfAborted();
        if (!currentChannel?.enabled) {
          await gate.skipDisabled(job, context);
          return;
        }
      }
      if (!request) {
        try {
          const [source, channel] = await Promise.all([
            identity.kind === 'notification' ? notificationDatabaseService.getAlertById(identity.sourceId) : reportDatabaseService.getReportById(identity.sourceId),
            notificationDatabaseService.getChannelById(identity.channelId),
          ]);
          signal.throwIfAborted();
          if (source && channel?.enabled && (identity.kind !== 'notification' || isAlertEligibleForChannel(source as any, channel))) {
            const validation = validateNotificationChannelConfig(channel.type, channel.config);
            if (validation.valid === false) throw new Error(validation.code);
            if (channel.type !== 'email' && !channel.config.webhook_url) throw new Error('WEBHOOK_CONFIGURATION_INVALID');
            const alert = source as Parameters<NotificationService['buildMessage']>[1];
            const transition = identity.transition;
            let notification = alert;
            if (transition) {
              const recovery = transition.phase === 'recovery';
              const manual = transition.cause === 'manual';
              const label = manual ? '手动关闭' : recovery ? '恢复' : '升级';
              const message = manual ? '模板事件已由授权人员手动关闭。' : recovery ? '固定规则已判定恢复。'
                : `等级 ${transition.from_level} → ${transition.to_level}`;
              notification = { ...alert, title: `[${label}] ${alert.title}`, message, level: transition.to_level ?? alert.level };
            }
            request = {
              channel,
              message: identity.kind === 'notification'
                ? notificationService.buildMessage(channel.type, notification, alert.instance_name, alert.instance_host)
                : { type: 'scheduled_report', report: { id: source.id, name: (source as any).name, type: (source as any).type, format: (source as any).format, status: (source as any).status }, downloadPath: `/api/reports/${source.id}/download` },
              rolloutFence: identity.kind === 'notification' ? parseRolloutAlertFence(source as any) : undefined,
            };
          }
        } catch (error) {
          signal.throwIfAborted();
          await gate.preflightFailed(job, context);
          throw error;
        }
      }
      signal.throwIfAborted();
      const claim = await gate.acquire(job, context, request);
      if (!claim) return;
      let transportStarted = false;
      try {
        signal.throwIfAborted();
        const publish = async () => {
          if (identity.kind === 'notification' && await maintenanceBlocksDelivery(identity.sourceId,identity.transition?.at)) {
            throw new Error('MAINTENANCE_SUPPRESSED');
          }
          // One transport invocation only. SMTP and ordinary webhooks have no receiver deduplication contract.
          const sendSignal = claim.retryDeadline === undefined ? signal
            : AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, claim.retryDeadline - Date.now()))]);
          const result = await notificationService.send(claim.request.channel, claim.request.message, sendSignal, claim.key, claim.retryDeadline, () => { transportStarted = true; });
          signal.throwIfAborted();
          if (!result.success) throw new Error(transportStarted ? 'DELIVERY_TRANSPORT_UNCERTAIN' : result.error || 'DELIVERY_PREPARATION_FAILED');
          // A successful sender has confirmed acceptance, including injected senders.
          transportStarted = true;
        };
        const outcome = identity.kind === 'notification' && claim.request.rolloutFence
          ? await publicationGate.run(identity.sourceId, claim.request.rolloutFence, publish)
          : (await publish(), 'published');
        if (outcome === 'stale') {
          await gate.finish(job, context, claim, 'skipped', 'ROLLOUT_ALERT_STALE');
          return;
        }
        await gate.finish(job, context, claim, 'sent');
      } catch (error) {
        if (error instanceof Error && error.message === 'MAINTENANCE_SUPPRESSED') {
          await gate.finish(job, context, claim, 'skipped', 'MAINTENANCE_SUPPRESSED');
          return;
        }
        // Persist only safe codes, and use the same preparation error in the job and delivery audit.
        const candidate = error instanceof Error ? error.message : undefined;
        const code = candidate && /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)
          ? candidate : 'DELIVERY_PREPARATION_FAILED';
        // Cancellation stops transport, not settlement of a known outcome. The SQL gate
        // still checks worker, fencing token and live lease before accepting this write.
        const settlementContext = signal.aborted ? { ...context, signal: new AbortController().signal } : context;
        // A contracted retry cannot erase uncertainty from an earlier send.
        const uncertain = transportStarted || claim.retryDeadline !== undefined;
        if (!signal.aborted || !uncertain) {
          await gate.finish(job, settlementContext, claim, uncertain ? 'unknown' : 'retryable',
            uncertain ? 'DELIVERY_OUTCOME_UNCERTAIN' : code).catch(() => {});
        }
        throw transportStarted ? error : new Error(code);
      }
    });
  }
}
