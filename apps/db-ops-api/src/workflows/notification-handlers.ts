import type { JobRegistry } from './job-registry.js';
import type { notificationDatabaseService as NotificationDatabase } from '../notification-database-service.js';
import type { NotificationService } from '../notification-service.js';
import type { reportDatabaseService as ReportDatabase } from '../report-database-service.js';
import { validateNotificationChannelConfig } from '../notification-channel-config.js';
import { isAlertEligibleForChannel } from './notification-dispatch.js';
import { deliveryIdentity, deliveryStore, type DeliveryGate, type DeliveryRequest } from './delivery-store.js';
import { parseRolloutAlertFence, rolloutAlertPublicationGate,
  type RolloutAlertPublicationGate } from '../metrics-v2/rollout/alert-publication-fence.js';

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
        if (!currentChannel?.enabled) throw new Error('DELIVERY_CHANNEL_DISABLED');
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
            request = {
              channel,
              message: identity.kind === 'notification'
                ? notificationService.buildMessage(channel.type, source as any, (source as any).instance_name, (source as any).instance_host)
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
          transportStarted = true;
          // One transport invocation only. SMTP and ordinary webhooks have no receiver deduplication contract.
          const sendSignal = claim.retryDeadline === undefined ? signal
            : AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, claim.retryDeadline - Date.now()))]);
          const result = await notificationService.send(claim.request.channel, claim.request.message, sendSignal, claim.key, claim.retryDeadline);
          signal.throwIfAborted();
          if (!result.success) throw new Error('DELIVERY_TRANSPORT_UNCERTAIN');
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
        // Failures before transport are retryable; after invocation the receiver outcome is uncertain.
        if (!signal.aborted) await gate.finish(job, context, claim, transportStarted ? 'unknown' : 'retryable',
          transportStarted ? 'DELIVERY_OUTCOME_UNCERTAIN' : 'ROLLOUT_ALERT_FENCE_UNAVAILABLE').catch(() => {});
        throw error;
      }
    });
  }
}
