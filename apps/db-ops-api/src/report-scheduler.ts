import { CronTime } from 'cron';
import type { ReportConfig } from './report-config-database-service.js';

export interface ReportOccurrence { configId: number; occurrenceAt: Date; }
export interface ReportOccurrenceStore {
  lastOccurrence(configId: number): Promise<Date | null>;
  claim(occurrence: ReportOccurrence): Promise<boolean>;
  complete(occurrence: ReportOccurrence, reportId: number): Promise<void>;
  fail(occurrence: ReportOccurrence, error: Error): Promise<void>;
}

export function nextReportOccurrence(config: Pick<ReportConfig, 'id' | 'cron' | 'created_at'>, last: Date | null, now: Date): ReportOccurrence | null {
  const cron = new CronTime(config.cron);
  const from = last ?? new Date(config.created_at);
  const next = cron.getNextDateFrom(from).toJSDate();
  return next <= now ? { configId: config.id, occurrenceAt: next } : null;
}

export class ReportScheduler {
  constructor(private readonly configs: { getEnabledConfigs(): Promise<ReportConfig[]> }, private readonly occurrences: ReportOccurrenceStore) {}
  async claimDue(now = new Date()): Promise<ReportOccurrence[]> {
    const due: ReportOccurrence[] = [];
    for (const config of await this.configs.getEnabledConfigs()) {
      const occurrence = nextReportOccurrence(config, await this.occurrences.lastOccurrence(config.id), now);
      if (occurrence && await this.occurrences.claim(occurrence)) due.push(occurrence);
    }
    return due;
  }
}

interface SqlPool { execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
export class MysqlReportOccurrenceStore implements ReportOccurrenceStore {
  constructor(private readonly poolProvider: () => SqlPool | null) {}
  async lastOccurrence(configId: number): Promise<Date | null> {
    const [rows] = await this.pool().execute<Array<{ occurrenceAt: Date | string | null }>>('SELECT MAX(occurrence_at) AS occurrenceAt FROM report_schedule_occurrences WHERE config_id = ? AND state = \'completed\'', [configId]);
    return rows[0]?.occurrenceAt ? new Date(rows[0].occurrenceAt) : null;
  }
  async claim(occurrence: ReportOccurrence): Promise<boolean> {
    const pool = this.pool();
    const [insert] = await pool.execute<{ affectedRows: number }>('INSERT IGNORE INTO report_schedule_occurrences (config_id, occurrence_at, state) VALUES (?, ?, \'running\')', [occurrence.configId, occurrence.occurrenceAt]);
    if (Number(insert.affectedRows) === 1) return true;
    const [retry] = await pool.execute<{ affectedRows: number }>('UPDATE report_schedule_occurrences SET state = \'running\', last_error = NULL WHERE config_id = ? AND occurrence_at = ? AND state = \'failed\'', [occurrence.configId, occurrence.occurrenceAt]);
    return Number(retry.affectedRows) === 1;
  }
  async complete(occurrence: ReportOccurrence, reportId: number): Promise<void> {
    await this.pool().execute('UPDATE report_schedule_occurrences SET state = \'completed\', report_id = ?, last_error = NULL WHERE config_id = ? AND occurrence_at = ?', [reportId, occurrence.configId, occurrence.occurrenceAt]);
  }
  async fail(occurrence: ReportOccurrence, error: Error): Promise<void> {
    await this.pool().execute('UPDATE report_schedule_occurrences SET state = \'failed\', last_error = ? WHERE config_id = ? AND occurrence_at = ?', [error.message.slice(0, 4096), occurrence.configId, occurrence.occurrenceAt]);
  }
  private pool(): SqlPool { const pool = this.poolProvider(); if (!pool) throw new Error('REPORT_SCHEDULE_STORE_UNAVAILABLE'); return pool; }
}
