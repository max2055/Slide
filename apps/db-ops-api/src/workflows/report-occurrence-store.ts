import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ReportConfig } from '../report-config-database-service.js';
import type { CreateReportData, Report, ReportStatus } from '../report-database-service.js';
import { createReportNotificationJob, createReportOccurrenceJob, type ReportOccurrence } from '../report-scheduler.js';
import { MysqlWorkflowStore, type ClaimedJob, type JobExecutionContext } from './worker-runtime.js';
import { OutboxService, type TransactionPool } from './outbox-service.js';
import { assertWorkflowActive } from './execution-context.js';

export interface OwnedReportOccurrence extends ReportOccurrence {
  job: ClaimedJob;
  context: JobExecutionContext;
  config: ReportConfig;
}
export interface ReportOccurrenceStore {
  lastOccurrence(configId: number): Promise<Date | null>;
  schedule(occurrence: ReportOccurrence, config: ReportConfig): Promise<boolean>;
  claim(occurrence: ReportOccurrence, job: ClaimedJob, context: JobExecutionContext): Promise<OwnedReportOccurrence | null>;
  savedReport(occurrence: OwnedReportOccurrence): Promise<Report | null>;
  createReport(occurrence: OwnedReportOccurrence, data: CreateReportData): Promise<Report>;
  updateReport(occurrence: OwnedReportOccurrence, id: number, status: ReportStatus, content?: string, data?: unknown): Promise<void>;
  complete(occurrence: OwnedReportOccurrence, reportId: number): Promise<void>;
  fail(occurrence: OwnedReportOccurrence, error: Error): Promise<void>;
}

export class MysqlReportOccurrenceStore implements ReportOccurrenceStore {
  constructor(private readonly poolProvider: () => Pool | null) {}
  private pool(): Pool { const pool = this.poolProvider(); if (!pool) throw new Error('REPORT_SCHEDULE_STORE_UNAVAILABLE'); return pool; }
  async lastOccurrence(configId: number): Promise<Date | null> {
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      `SELECT MAX(occurrence_at) AS occurrenceAt FROM report_schedule_occurrences
       WHERE config_id = ? AND (workflow_job_id IS NOT NULL OR state = 'completed')`, [configId]);
    return rows[0]?.occurrenceAt ? new Date(rows[0].occurrenceAt) : null;
  }
  private async transaction<T>(work: (connection: PoolConnection) => Promise<T>, owner?: { job: ClaimedJob; context: JobExecutionContext }): Promise<T> {
    const connection = await this.pool().getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      assertWorkflowActive();
      if (owner) await this.lockJob(connection, owner.job, owner.context);
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async schedule(occurrence: ReportOccurrence, config: ReportConfig): Promise<boolean> {
    assertWorkflowActive();
    const job = createReportOccurrenceJob(occurrence);
    return this.transaction(async connection => {
      await connection.execute(
        `INSERT IGNORE INTO report_schedule_occurrences (config_id, occurrence_at, state, workflow_job_id, config_snapshot)
         VALUES (?, ?, 'queued', ?, ?)`, [occurrence.configId, occurrence.occurrenceAt, job.id, JSON.stringify(config)]);
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT workflow_job_id FROM report_schedule_occurrences WHERE config_id = ? AND occurrence_at = ? FOR UPDATE',
        [occurrence.configId, occurrence.occurrenceAt]);
      // Never auto-replay legacy running/failed rows with unverifiable side effects.
      if (rows[0]?.workflow_job_id !== job.id) return false;
      await new MysqlWorkflowStore(() => connection as any).enqueue(job);
      return true;
    });
  }
  private async lockJob(connection: PoolConnection, job: ClaimedJob, context: JobExecutionContext): Promise<void> {
    context.signal.throwIfAborted();
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM workflow_jobs WHERE BINARY id = BINARY ? AND job_type = 'report.occurrence' AND state = 'running'
       AND BINARY lease_owner = BINARY ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`,
      [job.id, context.workerId, context.fencingToken]);
    if (context.fencingToken !== job.fencingToken || rows.length !== 1) throw new Error('REPORT_OCCURRENCE_LEASE_LOST');
  }
  private async lock(connection: PoolConnection, occurrence: OwnedReportOccurrence): Promise<RowDataPacket> {
    await this.lockJob(connection, occurrence.job, occurrence.context);
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM report_schedule_occurrences WHERE config_id = ? AND occurrence_at = ?
       AND workflow_job_id = ? AND BINARY lease_owner = BINARY ? AND fencing_token = ? FOR UPDATE`,
      [occurrence.configId, occurrence.occurrenceAt, occurrence.job.id, occurrence.context.workerId, occurrence.context.fencingToken]);
    if (rows.length !== 1) throw new Error('REPORT_OCCURRENCE_LEASE_LOST');
    return rows[0];
  }
  async claim(occurrence: ReportOccurrence, job: ClaimedJob, context: JobExecutionContext): Promise<OwnedReportOccurrence | null> {
    return this.transaction(async connection => {
      await this.lockJob(connection, job, context);
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT * FROM report_schedule_occurrences WHERE config_id = ? AND occurrence_at = ? AND BINARY workflow_job_id = BINARY ? FOR UPDATE`,
        [occurrence.configId, occurrence.occurrenceAt, job.id]);
      const row = rows[0];
      if (!row) throw new Error('REPORT_OCCURRENCE_NOT_FOUND');
      if (row.state === 'completed') return null;
      if (Number(row.fencing_token) > context.fencingToken) throw new Error('REPORT_OCCURRENCE_LEASE_LOST');
      await connection.execute(
        `UPDATE report_schedule_occurrences SET state = 'running', lease_owner = ?, fencing_token = ?, last_error = NULL
         WHERE config_id = ? AND occurrence_at = ?`, [context.workerId, context.fencingToken, occurrence.configId, occurrence.occurrenceAt]);
      const config = typeof row.config_snapshot === 'string' ? JSON.parse(row.config_snapshot) : row.config_snapshot;
      return { ...occurrence, job, context, config };
    }, { job, context });
  }
  private async report(connection: PoolConnection, id: number | null): Promise<Report | null> {
    if (!id) return null;
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT * FROM reports WHERE id = ?', [id]);
    const report = rows[0];
    if (report && typeof report.data === 'string') report.data = JSON.parse(report.data);
    return (report as Report | undefined) ?? null;
  }
  async savedReport(occurrence: OwnedReportOccurrence): Promise<Report | null> {
    return this.transaction(async connection => {
      const row = await this.lock(connection, occurrence);
      const saved = await this.report(connection, row.staged_report_id);
      if (row.staged_report_id && !saved) throw new Error('REPORT_OCCURRENCE_CONTENT_MISSING');
      return saved;
    }, occurrence);
  }
  async createReport(occurrence: OwnedReportOccurrence, data: CreateReportData): Promise<Report> {
    return this.transaction(async connection => {
      const row = await this.lock(connection, occurrence);
      if (row.state !== 'running') throw new Error('REPORT_OCCURRENCE_NOT_RUNNING');
      const saved = await this.report(connection, row.staged_report_id);
      if (saved?.status === 'completed') return saved;
      if (row.staged_report_id && !saved) throw new Error('REPORT_OCCURRENCE_CONTENT_MISSING');
      const values = [data.name, data.type, data.format ?? 'html', data.instance_id ?? null, data.server_id ?? null,
        data.content ?? null, data.data == null ? null : JSON.stringify(data.data), data.generated_by ?? null, data.status ?? 'pending'];
      let id = saved?.id;
      if (id) {
        await connection.execute('UPDATE reports SET name=?, type=?, format=?, instance_id=?, server_id=?, content=?, data=?, generated_by=?, status=? WHERE id=?', [...values, id]);
      } else {
        const [result] = await connection.execute<any>(
          'INSERT INTO reports (name,type,format,instance_id,server_id,content,data,generated_by,status) VALUES (?,?,?,?,?,?,?,?,?)', values);
        id = result.insertId;
        await connection.execute('UPDATE report_schedule_occurrences SET staged_report_id = ? WHERE config_id = ? AND occurrence_at = ?', [id, occurrence.configId, occurrence.occurrenceAt]);
      }
      return (await this.report(connection, id!))!;
    }, occurrence);
  }
  async updateReport(occurrence: OwnedReportOccurrence, id: number, status: ReportStatus, content?: string, data?: unknown): Promise<void> {
    await this.transaction(async connection => {
      const row = await this.lock(connection, occurrence);
      if (row.state !== 'running' || Number(row.staged_report_id) !== id) throw new Error('REPORT_OCCURRENCE_REPORT_MISMATCH');
      const saved = await this.report(connection, id);
      if (!saved || saved.status === 'completed') throw new Error('REPORT_OCCURRENCE_CONTENT_IMMUTABLE');
      const updates = ['status = ?']; const values: any[] = [status];
      if (content !== undefined) { updates.push('content = ?'); values.push(content); }
      if (data !== undefined) { updates.push('data = ?'); values.push(JSON.stringify(data)); }
      await connection.execute(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`, [...values, id]);
    }, occurrence);
  }
  async complete(occurrence: OwnedReportOccurrence, reportId: number): Promise<void> {
    await this.transaction(async connection => {
      const row = await this.lock(connection, occurrence);
      if (row.state !== 'running' || Number(row.staged_report_id) !== reportId) throw new Error('REPORT_OCCURRENCE_REPORT_MISMATCH');
      if ((await this.report(connection, reportId))?.status !== 'completed') throw new Error('REPORT_GENERATION_INCOMPLETE');
      const outbox = new OutboxService(this.pool() as unknown as TransactionPool);
      for (const channelId of new Set(occurrence.config.notification_channel_ids)) {
        const job = createReportNotificationJob(reportId, channelId);
        await outbox.append({ execute: (sql, values) => connection.execute(sql, values as any[]) }, {
          eventType: job.type, schemaVersion: 1, aggregateType: 'report', aggregateId: String(reportId),
          aggregateVersion: 1, payload: job.payload, idempotencyKey: job.idempotencyKey,
        });
        // Publishing to the local durable queue participates in the same commit.
        await new MysqlWorkflowStore(() => connection as any).enqueue(job);
        await connection.execute('UPDATE outbox_events SET published_at = NOW() WHERE idempotency_key = ?', [job.idempotencyKey]);
      }
      await connection.execute(
        `UPDATE report_schedule_occurrences SET state = 'completed', report_id = ?, last_error = NULL WHERE config_id = ? AND occurrence_at = ?`,
        [reportId, occurrence.configId, occurrence.occurrenceAt]);
    }, occurrence);
  }
  async fail(occurrence: OwnedReportOccurrence, error: Error): Promise<void> {
    await this.transaction(async connection => {
      const row = await this.lock(connection, occurrence);
      if (row.state === 'completed') return;
      await connection.execute(`UPDATE report_schedule_occurrences SET state = 'failed', last_error = ? WHERE config_id = ? AND occurrence_at = ?`,
        [error.message.slice(0, 4096), occurrence.configId, occurrence.occurrenceAt]);
    }, occurrence);
  }
}
