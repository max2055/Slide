import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pool, executeSql } = vi.hoisted(() => ({
  pool: { execute: vi.fn(), query: vi.fn() }, executeSql: vi.fn(),
}));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => pool } }));
vi.mock('./sql-executor', () => ({ sqlExecutor: { executeSql } }));
vi.mock('./llm-service', () => ({ llmService: {} }));
import { approvalService } from './approval-service.js';

// #314 / MAX-334: exercise the real service against a stateful CAS store.
describe('SQL approval exception settlement', () => {
  let row: any;
  let events: Array<{ type: string; data: any }>;
  let failSettlement: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    row = { id: 1, instance_id: 7, status: 'pending', sql_text: 'UPDATE x SET y=1', operation_id: 'op-1' };
    events = [];
    failSettlement = false;
    pool.execute.mockImplementation(async (sql: string, values: any[]) => {
      if (sql.startsWith('SELECT')) return [[row.status === 'pending' ? { ...row } : undefined].filter(Boolean)];
      if (sql.includes('INSERT INTO approval_events')) {
        events.push({ type: values[1], data: JSON.parse(values[2]) });
        return [{ affectedRows: 1 }];
      }
      if (failSettlement && sql.includes('execution_result')) throw new Error('store unavailable');
      if (sql.includes('SET execution_result')) row.execution_result = JSON.parse(values[0]);
      else {
        if (sql.includes('AND status = ?') && row.status !== values.at(-1)) return [{ affectedRows: 0 }];
        row.status = values[0];
        if (sql.includes('execution_result')) row.execution_result = JSON.parse(values[sql.includes('rollback_info') ? 3 : 1]);
      }
      return [{ affectedRows: 1 }];
    });
    pool.query.mockImplementation(async (sql: string) => [[
      ...(sql.includes(`'${row.status}'`) ? [{ ...row }] : []),
    ]]);
    executeSql.mockResolvedValue({ success: true, executionState: 'succeeded' });
  });
  const review = (lifecycle = {}) => approvalService.reviewRequest(1, { action: 'approve', reviewed_by: 3 }, lifecycle);

  it.each(['onClaimed', 'onExecutionStarted'])('settles %s failure as definitely not started', async hook => {
    const result = await review({ [hook]: async () => { throw new Error('lifecycle unavailable'); } });
    expect(result.success).toBe(false);
    expect(executeSql).not.toHaveBeenCalled();
    expect(row.status).toBe('execution_failed');
    expect(row.execution_result).toMatchObject({ executionState: 'not_started', retryable: false });
    expect(events.some(event => event.type === 'execution_failed')).toBe(true);
  });

  it('honors an executor-confirmed pre-send rejection', async () => {
    executeSql.mockResolvedValue({ success: false, executionState: 'not_started', retryable: false, error: 'intent rejected' });
    expect((await review()).success).toBe(false);
    expect(row.status).toBe('execution_failed');
    expect(row.execution_result.executionState).toBe('not_started');
  });

  it.each(['throw', 'unknown'])('keeps %s executor outcomes claimed for reconciliation and refuses replay', async kind => {
    if (kind === 'throw') executeSql.mockRejectedValue(new Error('connection dropped after send'));
    else executeSql.mockResolvedValue({ success: false, executionState: 'unknown', retryable: false });
    const onCompleted = vi.fn();
    const result = await review({ onCompleted });
    expect(result.execution_result).toMatchObject({ executionState: 'unknown', retryable: false });
    expect(row.status).toBe('executing');
    expect(row.execution_result.executionState).toBe('unknown');
    expect(events.some(event => event.type === 'reconciliation_required')).toBe(true);
    expect(onCompleted).not.toHaveBeenCalled();
    await review();
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('returns reconciliation evidence even when all outcome persistence fails', async () => {
    executeSql.mockImplementation(async () => {
      failSettlement = true;
      return { success: true, executionState: 'succeeded' };
    });
    const onCompleted = vi.fn();
    const result = await review({ onCompleted });
    expect(result).toMatchObject({ success: false, execution_result: { executionState: 'unknown', retryable: false, persistenceError: 'store unavailable' } });
    expect(row.status).toBe('executing');
    expect(events.some(event => event.type === 'reconciliation_required')).toBe(true);
    expect(onCompleted).not.toHaveBeenCalled();
    await review();
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite executed SQL as failed when completion lifecycle fails', async () => {
    const result = await review({ onCompleted: async () => { throw new Error('completion unavailable'); } });
    expect(row.status).toBe('executed');
    expect(result).toMatchObject({ success: false, execution_result: { executionState: 'succeeded', retryable: false, stage: 'operation_completion' } });
    expect(events.some(event => event.type === 'reconciliation_required')).toBe(true);
  });

  it('preserves a committed terminal write whose acknowledgement was lost', async () => {
    const persist = pool.execute.getMockImplementation()!;
    pool.execute.mockImplementation(async (sql: string, values: any[]) => {
      const result = await persist(sql, values);
      if (sql.includes('rollback_info')) throw new Error('lost storage acknowledgement');
      return result;
    });
    const result = await review();
    expect(row.status).toBe('executed');
    expect(result.execution_result).toMatchObject({ executionState: 'unknown', retryable: false, observedResult: { success: true } });
    await review();
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('reports a pre-start failure even when its terminal write fails', async () => {
    failSettlement = true;
    const result = await review({ onExecutionStarted: async () => { throw new Error('start unavailable'); } });
    expect(result.execution_result).toMatchObject({ executionState: 'not_started', retryable: false, persistenceError: 'store unavailable' });
    expect(row.status).toBe('executing');
    expect(executeSql).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'reconciliation_required')).toBe(true);
  });

  it('allows only one concurrent reviewer to execute SQL', async () => {
    await Promise.all([review(), review()]);
    expect(executeSql).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('executed');
  });

  it('lists executing records for diagnosis while preserving instance scope', async () => {
    row.status = 'executing';
    expect(await approvalService.getProcessedRequests(50, [7])).toHaveLength(1);
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining('instance_id IN (?)'), [7, 50]);
    await approvalService.getProcessedRequests(50, []);
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining('AND 1 = 0'), [50]);
  });
});
