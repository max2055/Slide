import { describe, expect, it, vi } from 'vitest';
import { AgentToolApprovalService } from './agent-tool-approval-service.js';

// MAX-351 / #565: a failed batch must not leave invisible completed reviews.
function store(failAt?: number, commitUnknown = false, rollbackFails = false) {
  let persisted: string[] = [];
  let staged: string[] | undefined;
  let updates = 0;
  const connection = {
    release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === 'START TRANSACTION') { staged = []; return [{}]; }
      if (sql === 'ROLLBACK') {
        if (rollbackFails) throw new Error('rollback lost');
        staged = undefined; return [{}];
      }
      if (sql === 'COMMIT') {
        persisted.push(...(staged ?? [])); staged = undefined;
        if (commitUnknown) throw new Error('commit acknowledgement lost');
        return [{}];
      }
      if (sql.includes('SELECT id FROM')) return [[{ id: 41 }, { id: 42 }, { id: 43 }]];
      if (sql.includes('UPDATE agent_tool_approvals')) {
        updates += 1;
        if (updates === failAt) throw new Error('write failed');
        (staged ?? persisted).push(String(values?.at(-1)));
        return [{ affectedRows: 1 }];
      }
      throw new Error('unexpected query');
    }),
  };
  Object.assign(connection, {
    beginTransaction: () => connection.execute('START TRANSACTION'),
    commit: () => connection.execute('COMMIT'),
    rollback: () => connection.execute('ROLLBACK'),
  });
  return { connection, persisted: () => persisted,
    service: new AgentToolApprovalService(() => ({ ...connection, getConnection: async () => connection }) as any, 'test-hmac-key') };
}

describe('atomic batch reviews', () => {
  it('preserves action-plan isolation for a legacy connection adapter', async () => {
    const connection = { execute: async () => [[]] as [any], release() {}, destroy() {} };
    const service = new AgentToolApprovalService(() => ({ ...connection, getConnection: async () => connection }), 'test-hmac-key');
    await expect(service.reviewPendingByTool('operations_action_plan', 9, 'approve')).resolves.toEqual([]);
  });
  it.each([1, 2, 3])('rolls back all reviews on write failure at %i', async position => {
    const test = store(position);
    await expect(test.service.reviewPendingByTool('execute_code', 9, 'approve')).rejects.toThrow();
    expect(test.persisted()).toEqual([]);
    expect(test.connection.release).toHaveBeenCalledOnce();
  });

  it('returns committed IDs only after commit', async () => {
    const test = store();
    await expect(test.service.reviewPendingByTool('execute_code', 9, 'reject')).resolves.toEqual(['41', '42', '43']);
    expect(test.persisted()).toEqual(['41', '42', '43']);
    expect(test.connection.execute.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('marks lost commit acknowledgement unknown without replaying any write', async () => {
    const test = store(undefined, true);
    await expect(test.service.reviewPendingByTool('execute_code', 9, 'approve'))
      .rejects.toThrow('AGENT_APPROVAL_BATCH_REVIEW_OUTCOME_UNKNOWN');
    expect(test.persisted()).toEqual(['41', '42', '43']);
    expect(test.connection.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(3);
    expect(test.connection.destroy).toHaveBeenCalledOnce();
    expect(test.connection.release).not.toHaveBeenCalled();
  });

  it('discards a connection whose rollback cannot be confirmed', async () => {
    const test = store(2, false, true);
    await expect(test.service.reviewPendingByTool('execute_code', 9, 'approve')).rejects.toThrow();
    expect(test.connection.destroy).toHaveBeenCalledOnce();
    expect(test.connection.release).not.toHaveBeenCalled();
  });
});
