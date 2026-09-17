import type { reportConfigService } from '../report-config-database-service.js';
import type { reportService } from '../report-service.js';
import type { ServerReportService } from '../server-report-service.js';
import { ReportScheduler, type ReportOccurrenceStore } from '../report-scheduler.js';
import type { JobRegistry } from './job-registry.js';

interface ReportScheduleDependencies {
  reportConfigService: Pick<typeof reportConfigService, 'getEnabledConfigs' | 'getConfigById'>;
  serverReportService: Pick<ServerReportService, 'generateAndPersist'>;
  reportService: Pick<typeof reportService, 'generateReport'>;
  enqueueReportSchedule: (availableAt: Date) => Promise<void>;
  enqueueReportNotifications: (reportId: number, channelIds: readonly number[]) => Promise<void>;
  createOccurrenceStore: () => ReportOccurrenceStore;
}

export function registerReportScheduleHandler(registry: JobRegistry, deps: ReportScheduleDependencies): void {
  const { reportConfigService, serverReportService, reportService, enqueueReportSchedule, enqueueReportNotifications, createOccurrenceStore } = deps;
  registry.register('report.schedule', async (_payload, _job, { signal }) => {
    // Commit the successor before generating reports so a restart cannot
    // silently stop all scheduled report processing.
    signal.throwIfAborted();
    await enqueueReportSchedule(new Date(Date.now() + 60_000));
    const occurrences = createOccurrenceStore();
    const scheduler = new ReportScheduler(reportConfigService, occurrences);
    signal.throwIfAborted();
    for (const occurrence of await scheduler.claimDue()) {
      try {
        signal.throwIfAborted();
        const config = await reportConfigService.getConfigById(occurrence.configId);
        if (!config) throw new Error('REPORT_CONFIG_NOT_FOUND');
        signal.throwIfAborted();
        const reportId = config.type === 'server_health'
          ? (await serverReportService.generateAndPersist(config.server_id ? [config.server_id] : undefined)).reportId
          : (await reportService.generateReport(config.type as any, config.instance_id, { format: config.format as any })).id;
        if (!reportId) throw new Error('REPORT_GENERATION_FAILED');
        signal.throwIfAborted();
        await occurrences.complete(occurrence, reportId);
        signal.throwIfAborted();
        await enqueueReportNotifications(reportId, config.notification_channel_ids);
      } catch (error) {
        signal.throwIfAborted();
        await occurrences.fail(occurrence, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  });
}
