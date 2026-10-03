import type { Pool, RowDataPacket } from 'mysql2/promise';

/** Read-only inventory. Candidate proximity never authorizes linking or replay. */
export async function reportRecoveryInventory(pool: Pool, afterConfigId = 0, limit = 200) {
  if (!Number.isSafeInteger(afterConfigId) || afterConfigId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('REPORT_INVENTORY_ARGUMENT_INVALID');
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT o.config_id AS configId, o.occurrence_at AS occurrenceAt, o.state,
      o.report_id AS reportId, o.staged_report_id AS stagedReportId,
      c.type, c.instance_id AS instanceId, c.server_id AS serverId,
      c.notification_channel_ids AS channelIds,
      r.status AS reportStatus,
      o.workflow_job_id AS jobId, o.lease_owner AS owner, o.fencing_token AS fencingToken,
      EXISTS(SELECT 1 FROM workflow_jobs j WHERE BINARY j.id = BINARY o.workflow_job_id
        AND j.state = 'running' AND BINARY j.lease_owner = BINARY o.lease_owner
        AND j.fencing_token = o.fencing_token AND j.lease_expires_at > NOW()) AS activeOwner
     FROM report_schedule_occurrences o
     LEFT JOIN report_configs c ON c.id = o.config_id
     LEFT JOIN reports r ON r.id = COALESCE(o.report_id, o.staged_report_id)
     WHERE o.config_id > ? AND o.workflow_job_id IS NULL
     ORDER BY o.config_id, o.occurrence_at LIMIT ${limit + 1}`, [afterConfigId]);
  // Pagination at a config boundary avoids losing multiple occurrences for one config.
  const overflowConfig = rows.length > limit ? rows[limit].configId : null;
  const selected = overflowConfig === null ? rows : rows.filter(row => row.configId < overflowConfig);
  if (overflowConfig !== null && selected.length === 0) throw new Error('REPORT_INVENTORY_CONFIG_EXCEEDS_PAGE_INCREASE_LIMIT');
  const entries = [];
  for (const row of selected) {
    const channelIds = typeof row.channelIds === 'string' ? JSON.parse(row.channelIds) : row.channelIds ?? [];
    const reportId = row.reportId ?? row.stagedReportId;
    const [deliveries] = reportId ? await pool.execute<RowDataPacket[]>(
      `SELECT channel_id AS channelId, status, workflow_job_id AS jobId, attempt_number AS attempt
       FROM report_notification_deliveries WHERE report_id = ? ORDER BY channel_id, attempt_number`, [reportId]) : [[]];
    const [outbox] = reportId ? await pool.execute<RowDataPacket[]>(
      `SELECT idempotency_key AS intentKey, published_at AS publishedAt FROM outbox_events
       WHERE aggregate_type = 'report' AND aggregate_id = ? AND event_type = 'report.notify'`, [String(reportId)]) : [[]];
    // An old running row without report_id has no reliable provenance. List
    // possible target reports for human matching; never select one automatically.
    const [candidates] = !reportId && row.type ? await pool.execute<RowDataPacket[]>(
      `SELECT id, status, created_at AS createdAt FROM reports WHERE type = ?
       AND instance_id <=> ? AND server_id <=> ? AND created_at >= ? ORDER BY created_at LIMIT 21`,
      [row.type, row.instanceId, row.serverId, row.occurrenceAt]) : [[]];
    entries.push({ ...row, channelIds, deliveries, outbox, candidates: candidates.slice(0, 20),
      candidatesTruncated: candidates.length > 20,
      resolution: deliveries.some(item => item.status === 'started' || item.status === 'unknown')
        ? 'unknown_requires_receiver_reconciliation'
        : reportId && row.reportStatus === 'completed' ? 'linked_report_requires_notification_review'
        : 'unknown_requires_generation_review',
    });
  }
  return { dryRun: true, entries, nextAfterConfigId: overflowConfig === null ? null : selected.at(-1)!.configId };
}
