import { describe, expect, it, vi } from 'vitest';
import { authorizeApprovedSqlExecution, hashApprovedSql } from './approval-execution-authorizer.js';

const sql = 'UPDATE users SET status = 1 WHERE id = 7';
const grant = { approvalRequestId: 9, operationId: 'op-9', reviewerId: 3 };

function executor(overrides: Record<string, unknown> = {}) {
  return {
    execute: vi.fn().mockResolvedValue([[(Object.assign({
      id: 9,
      instance_id: 2,
      sql_hash: hashApprovedSql(sql),
      status: 'executing',
      operation_id: 'op-9',
      reviewed_by: 3,
      updated_at: new Date('2026-07-23T15:00:00.000Z'),
    }, overrides))]]),
  };
}

describe('approval execution authorizer', () => {
  it('authorizes only the persisted executing approval fact', async () => {
    await expect(authorizeApprovedSqlExecution(
      executor(), grant, { instanceId: 2, sql }, Date.parse('2026-07-23T15:05:00.000Z'),
    )).resolves.toBe(true);
  });

  it.each([
    [{ status: 'approved' }, grant, { instanceId: 2, sql }],
    [{ instance_id: 4 }, grant, { instanceId: 2, sql }],
    [{ operation_id: 'op-other' }, grant, { instanceId: 2, sql }],
    [{ reviewed_by: 8 }, grant, { instanceId: 2, sql }],
    [{ sql_hash: hashApprovedSql('DELETE FROM users') }, grant, { instanceId: 2, sql }],
    [{}, { ...grant, approvalRequestId: 0 }, { instanceId: 2, sql }],
  ])('rejects mismatched or forged approval facts', async (row, candidateGrant, command) => {
    await expect(authorizeApprovedSqlExecution(
      executor(row), candidateGrant, command, Date.parse('2026-07-23T15:05:00.000Z'),
    )).resolves.toBe(false);
  });

  it('rejects an expired execution window', async () => {
    await expect(authorizeApprovedSqlExecution(
      executor(), grant, { instanceId: 2, sql }, Date.parse('2026-07-23T15:16:00.001Z'),
    )).resolves.toBe(false);
  });
});
