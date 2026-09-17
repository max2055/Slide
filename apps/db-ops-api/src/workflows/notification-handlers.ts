import type { JobRegistry } from './job-registry.js';
import type { notificationDatabaseService as NotificationDatabase } from '../notification-database-service.js';
import type { NotificationService } from '../notification-service.js';
import type { reportDatabaseService as ReportDatabase } from '../report-database-service.js';
import { isAlertEligibleForChannel } from './notification-dispatch.js';

/** Shared registration keeps production delivery and cancellation probes on the same handlers. */
export function registerNotificationHandlers(
  registry: JobRegistry,
  notificationDatabaseService: Pick<typeof NotificationDatabase, 'getAlertById' | 'getChannelById' | 'recordDeliveryAttempt'>,
  notificationService: Pick<NotificationService, 'deliverAlertToChannel' | 'send'>,
  reportDatabaseService: Pick<typeof ReportDatabase, 'getReportById' | 'recordNotificationDelivery'>,
): void {
  registry.register('notification.deliver', async (payload, job, { signal }) => {
    const alertId = Number(payload.alertId);
    const channelId = Number(payload.channelId);
    if (!Number.isSafeInteger(alertId) || !Number.isSafeInteger(channelId)) throw new Error('NOTIFICATION_PAYLOAD_INVALID');
    signal.throwIfAborted();
    const [alert, channel] = await Promise.all([
      notificationDatabaseService.getAlertById(alertId),
      notificationDatabaseService.getChannelById(channelId),
    ]);
    if (!alert || !channel || !channel.enabled || !isAlertEligibleForChannel(alert, channel)) return;
    signal.throwIfAborted();
    await notificationDatabaseService.recordDeliveryAttempt({ job_id: job.id, alert_id: alertId, channel_id: channelId, attempt_number: job.attempts, status: 'started' });
    try {
      signal.throwIfAborted();
      await notificationService.deliverAlertToChannel(alert, channel, signal);
      signal.throwIfAborted();
      await notificationDatabaseService.recordDeliveryAttempt({ job_id: job.id, alert_id: alertId, channel_id: channelId, attempt_number: job.attempts, status: 'sent' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      signal.throwIfAborted();
      await notificationDatabaseService.recordDeliveryAttempt({ job_id: job.id, alert_id: alertId, channel_id: channelId, attempt_number: job.attempts, status: 'failed', error_code: message.slice(0, 128), error_message: message });
      throw error;
    }
  });
  registry.register('report.notify', async (payload, job, { signal }) => {
    const reportId = Number(payload.reportId);
    const channelId = Number(payload.channelId);
    if (!Number.isSafeInteger(reportId) || reportId <= 0 || !Number.isSafeInteger(channelId) || channelId <= 0) {
      throw new Error('REPORT_NOTIFICATION_PAYLOAD_INVALID');
    }
    signal.throwIfAborted();
    const [report, channel] = await Promise.all([
      reportDatabaseService.getReportById(reportId),
      notificationDatabaseService.getChannelById(channelId),
    ]);
    if (!report || !channel || !channel.enabled) {
      signal.throwIfAborted();
      await reportDatabaseService.recordNotificationDelivery({
        jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'skipped', errorCode: 'REPORT_OR_CHANNEL_UNAVAILABLE',
      });
      return;
    }
    signal.throwIfAborted();
    await reportDatabaseService.recordNotificationDelivery({
      jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'started',
    });
    signal.throwIfAborted();
    const result = await notificationService.send(channel, {
      type: 'scheduled_report',
      report: { id: report.id, name: report.name, type: report.type, format: report.format, status: report.status },
      downloadPath: `/api/reports/${report.id}/download`,
    }, signal);
    if (!result.success) {
      signal.throwIfAborted();
      await reportDatabaseService.recordNotificationDelivery({
        jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'failed',
        errorCode: result.error?.slice(0, 128), errorMessage: result.error,
      });
      throw new Error(result.error || 'REPORT_NOTIFICATION_FAILED');
    }
    signal.throwIfAborted();
    await reportDatabaseService.recordNotificationDelivery({
      jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'sent',
    });
  });
}
