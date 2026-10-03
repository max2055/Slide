import { AsyncLocalStorage } from 'node:async_hooks';
import type { CreateReportData, Report, ReportStatus } from '../report-database-service.js';

// Only scheduled generation uses this persistence boundary; interactive reports
// retain their existing API. Every write is checked against the durable owner.
export const scheduledReportPersistence = new AsyncLocalStorage<{
  create(data: CreateReportData): Promise<Report>;
  update(id: number, status: ReportStatus, content?: string, data?: unknown): Promise<void>;
}>();
