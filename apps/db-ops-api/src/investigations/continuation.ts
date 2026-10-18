import { isDeepStrictEqual } from 'node:util';
import type { RowDataPacket } from 'mysql2/promise';
import type { TransactionConnection } from '../workflows/outbox-service.js';
import { InvestigationStoreError } from './store.js';

export interface InvestigationContinuation { requestId: string; runId: string; resultVersion: number; notAfter?: string; }
const decode = (v: any) => typeof v === 'string' ? JSON.parse(v) : v;
const conflict = (): never => { throw new InvestigationStoreError('VERSION_CONFLICT'); };

/** Called under the original Session/investigation admission locks. This is a
 * new, explicit request, never permission to replay or repair the old Run. */
export async function assertKnownPartial(c: TransactionConnection, investigationId: string, previous: InvestigationContinuation,
  consumedByRequestId?: string) {
  const rows = async (sql: string, args: unknown[]) => (await c.execute(sql, args))[0] as RowDataPacket[];
  const [request] = await rows('SELECT * FROM investigation_requests WHERE id=? AND investigation_id=? FOR UPDATE',
    [previous.requestId, investigationId]);
  if (!request || request.cancel_requested_at) conflict();
  const [job] = await rows('SELECT * FROM workflow_jobs WHERE id=? FOR UPDATE', [request.job_id]);
  const [run] = await rows('SELECT * FROM agent_runs WHERE id=? AND idempotency_key=? FOR UPDATE',
    [previous.runId, `investigation:${previous.requestId}`]);
  const execution = decode(run?.result_json)?.investigationExecution;
  const snapshot = decode(request.request_snapshot), payload = decode(job?.payload);
  if (!job || payload?.investigationId !== investigationId || payload.requestId !== previous.requestId
    || run?.session_id !== snapshot?.sessionId || Number(run?.actor_id) !== Number(request.actor_id)
    || Number(execution?.fencingToken) !== Number(job.fencing_token) || !['completed', 'dead_letter'].includes(job.state) || job.lease_owner !== null || job.lease_expires_at !== null
    || run?.state !== 'partial' || run.message_id !== request.message_id || !execution
    || execution.requestId !== previous.requestId || execution.jobId !== request.job_id
    || execution.usageUnknown !== false || execution.provider !== null || !execution.tools
    || Object.values(execution.tools).some((t: any) => t.status !== 'returned')
    || decode(run.result_json)?.completionPending) conflict();
  const results = await rows(consumedByRequestId
    ? 'SELECT * FROM investigation_results WHERE investigation_id=? AND version=? FOR UPDATE'
    : 'SELECT * FROM investigation_results WHERE investigation_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE',
  consumedByRequestId ? [investigationId, previous.resultVersion] : [investigationId]);
  const result = results[0];
  if (!result || result.request_id !== previous.requestId || result.run_id !== previous.runId
    || Number(result.version) !== previous.resultVersion) conflict();
  const allocations = await rows('SELECT * FROM investigation_budget_ledger WHERE request_id=? FOR UPDATE', [previous.requestId]);
  if (allocations.length !== 1 || allocations[0].state !== 'settled' || !allocations[0].usage_snapshot
    || !allocations[0].settlement_hash || !allocations[0].settled_at) conflict();
  const usage = decode(allocations[0].usage_snapshot);
  if (!isDeepStrictEqual(usage, execution.usage)) conflict();
  const used = await rows(`SELECT id FROM investigation_requests WHERE investigation_id=?
    AND JSON_UNQUOTE(JSON_EXTRACT(request_snapshot,'$.continuationOf.requestId'))=? LIMIT 2 FOR UPDATE`,
  [investigationId, previous.requestId]);
  if (consumedByRequestId ? used.length !== 1 || used[0].id !== consumedByRequestId : used.length !== 0) conflict();
  const evidence = await rows('SELECT * FROM investigation_evidence WHERE request_id=? ORDER BY id FOR UPDATE', [previous.requestId]);
  return { request, job, run, result, allocation: allocations[0], evidence };
}

/** Optional operator deadline is admission-only, not reusable Run authority.
 * Sample after all request/message SQL and lock waits, immediately before the
 * original bridge transaction returns to commit. */
export async function assertContinuationDeadline(c: TransactionConnection, notAfter?: string) {
  if (notAfter === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(notAfter) || !Number.isFinite(Date.parse(notAfter))) conflict();
  const [rows] = await c.execute('SELECT UTC_TIMESTAMP(3) AS utc') as [RowDataPacket[], unknown];
  const deadline = Date.parse(notAfter), now = Math.max(Date.now(), new Date(rows[0].utc).getTime());
  if (!(deadline > now) || deadline - now > 600000) conflict();
}
