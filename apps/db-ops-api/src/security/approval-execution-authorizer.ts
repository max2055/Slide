import { createHash, timingSafeEqual } from 'node:crypto';

export interface ApprovalExecutionGrant {
  approvalRequestId: number;
  operationId: string;
  reviewerId: number;
}

interface ApprovalExecutionRow {
  id: number;
  instance_id: number;
  sql_hash: string;
  status: string;
  operation_id: string | null;
  reviewed_by: number | null;
  updated_at: string | Date;
}

export type ApprovalQueryExecutor = {
  execute(sql: string, values: unknown[]): Promise<[unknown, unknown?]>;
};

export function hashApprovedSql(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authorizeApprovedSqlExecution(
  executor: ApprovalQueryExecutor,
  grant: ApprovalExecutionGrant,
  command: { instanceId: number; sql: string },
  now = Date.now(),
): Promise<boolean> {
  if (!Number.isInteger(grant.approvalRequestId) || grant.approvalRequestId <= 0 ||
      !Number.isInteger(grant.reviewerId) || grant.reviewerId <= 0 || !grant.operationId) return false;

  const [rows] = await executor.execute(
    `SELECT id, instance_id, sql_hash, status, operation_id, reviewed_by, updated_at
     FROM approval_requests WHERE id = ?`,
    [grant.approvalRequestId],
  );
  const row = Array.isArray(rows) ? rows[0] as ApprovalExecutionRow | undefined : undefined;
  if (!row || row.status !== 'executing' || Number(row.instance_id) !== command.instanceId ||
      row.operation_id !== grant.operationId || Number(row.reviewed_by) !== grant.reviewerId) return false;

  const updatedAt = new Date(row.updated_at).getTime();
  if (!Number.isFinite(updatedAt) || now - updatedAt < 0 || now - updatedAt > 15 * 60_000) return false;
  return equalHash(String(row.sql_hash), hashApprovedSql(command.sql));
}
