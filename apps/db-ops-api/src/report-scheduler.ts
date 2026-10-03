import { assertWorkflowActive } from './workflows/execution-context.js';
import { CronTime } from 'cron';
import { createHash } from 'node:crypto';
export { MysqlReportOccurrenceStore } from './workflows/report-occurrence-store.js';
export type { ReportOccurrenceStore } from './workflows/report-occurrence-store.js';
import type { ReportOccurrenceStore } from './workflows/report-occurrence-store.js';
import type { ReportConfig } from './report-config-database-service.js';
import type { WorkflowJobInput } from './workflows/worker-runtime.js';

export interface ReportOccurrence { configId: number; occurrenceAt: Date; }
/** One durable scan per minute. Reusing the slot id makes restarts idempotent. */
export function createReportScheduleJob(availableAt = new Date()): WorkflowJobInput {
  const slot = Math.floor(availableAt.getTime() / 60_000);
  return {
    id: `report-schedule-${slot}`,
    type: 'report.schedule',
    schemaVersion: 1,
    payload: {},
    idempotencyKey: `report-schedule:${slot}`,
    maxAttempts: 5,
    availableAt,
  };
}

export function createReportNotificationJob(reportId: number, channelId: number): WorkflowJobInput {
  if (!Number.isSafeInteger(reportId) || reportId <= 0 || !Number.isSafeInteger(channelId) || channelId <= 0) {
    throw new Error('REPORT_NOTIFICATION_JOB_INVALID');
  }
  return {
    id: `report-notify-${reportId}-${channelId}`,
    type: 'report.notify',
    schemaVersion: 1,
    payload: { reportId, channelId },
    idempotencyKey: `report-notify:${reportId}:${channelId}`,
    maxAttempts: 5,
  };
}

export function nextReportOccurrence(config: Pick<ReportConfig, 'id' | 'cron' | 'created_at'>, last: Date | null, now: Date): ReportOccurrence | null {
  const cron = new CronTime(config.cron);
  const from = last ?? new Date(config.created_at);
  const next = cron.getNextDateFrom(from).toJSDate();
  return next <= now ? { configId: config.id, occurrenceAt: next } : null;
}

export class ReportScheduler {
  constructor(private readonly configs: { getEnabledConfigs(): Promise<ReportConfig[]> }, private readonly occurrences: ReportOccurrenceStore) {}
  async scheduleDue(now = new Date()): Promise<ReportOccurrence[]> {
    const due: ReportOccurrence[] = [];
    assertWorkflowActive();
    for (const config of await this.configs.getEnabledConfigs()) {
      assertWorkflowActive();
      const occurrence = nextReportOccurrence(config, await this.occurrences.lastOccurrence(config.id), now);
      assertWorkflowActive();
      if (occurrence && await this.occurrences.schedule(occurrence, config)) due.push(occurrence);
    }
    return due;
  }
}

/** UUID-sized deterministic identity fits the existing CHAR(36) workflow key. */
export function createReportOccurrenceJob(occurrence: ReportOccurrence): WorkflowJobInput {
  const key = `report-occurrence:${occurrence.configId}:${occurrence.occurrenceAt.toISOString()}`;
  const hash = createHash('sha256').update(key).digest('hex');
  return {
    id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
    type: 'report.occurrence', schemaVersion: 1,
    payload: { configId: occurrence.configId, occurrenceAt: occurrence.occurrenceAt.toISOString() },
    idempotencyKey: key, maxAttempts: 5,
  };
}
