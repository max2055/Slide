import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDatabaseTool } from './add_database.js';
import { addDatabaseBatchTool } from './add_database_batch.js';

describe('slide_add_database_batch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns an itemized result for mixed success and terminal failure', async () => {
    vi.spyOn(addDatabaseTool, 'handler')
      .mockResolvedValueOnce({
        success: true,
        data: { instanceId: 101, name: 'mysql_a_3306', connectionStatus: 'pending_credentials' },
      })
      .mockResolvedValueOnce({
        success: false,
        error: '连接失败',
        errorCode: 'CONNECTION_FAILED',
        details: { terminal: true, retryable: false },
      });

    const result = await addDatabaseBatchTool.handler({
      databases: [
        { db_type: 'mysql', host: 'db-a', port: 3306, username: 'root' },
        { db_type: 'postgresql', host: 'db-b', port: 5432, username: 'postgres' },
      ],
    }, { actor: { userId: 7 } as any } as any);

    expect(result).toMatchObject({
      success: true,
      status: 'warning',
      data: {
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { index: 0, status: 'pending_credentials', instanceId: 101, retryable: false },
          { index: 1, status: 'failed', errorCode: 'CONNECTION_FAILED', retryable: false },
        ],
      },
    });
    expect(addDatabaseTool.handler).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty or oversized batch before invoking item handlers', async () => {
    const handler = vi.spyOn(addDatabaseTool, 'handler');

    await expect(addDatabaseBatchTool.handler({ databases: [] }, { actor: { userId: 7 } as any } as any))
      .resolves.toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('contains an unexpected item exception and continues the batch', async () => {
    vi.spyOn(addDatabaseTool, 'handler')
      .mockRejectedValueOnce(new Error('database service unavailable'))
      .mockResolvedValueOnce({ success: true, data: { instanceId: 102, connectionStatus: 'connected' } });

    const result = await addDatabaseBatchTool.handler({
      databases: [
        { db_type: 'mysql', host: 'db-a', port: 3306, username: 'root' },
        { db_type: 'mysql', host: 'db-b', port: 3306, username: 'root' },
      ],
    }, { actor: { userId: 7 } as any } as any);

    expect(result).toMatchObject({
      data: {
        results: [
          { status: 'failed', errorCode: 'BATCH_ITEM_FAILED', retryable: true },
          { status: 'created', instanceId: 102 },
        ],
      },
    });
  });

  it('limits in-flight item handlers and reports progress in input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const progress: any[] = [];
    vi.spyOn(addDatabaseTool, 'handler').mockImplementation(async (args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { success: true, data: { instanceId: Number(args.port) } };
    });

    const result = await addDatabaseBatchTool.handler({
      concurrency: 2,
      databases: Array.from({ length: 5 }, (_, index) => ({ db_type: 'mysql', host: `db-${index}`, port: 3306 + index, username: 'root' })),
    }, { actor: { userId: 7 } as any, progressCallback: (event: any) => progress.push(event) } as any);

    expect(maxInFlight).toBe(2);
    expect((result.data as any)?.results.map((item: any) => item.index)).toEqual([0, 1, 2, 3, 4]);
    expect(progress).toHaveLength(5);
    expect(progress.at(-1)).toMatchObject({ completed: 5, total: 5 });
  });

  it('does not count a pre-start cancellation as a retryable failure', async () => {
    const controller = new AbortController();
    controller.abort();
    controller.abort();
    const handler = vi.spyOn(addDatabaseTool, 'handler');
    const result = await addDatabaseBatchTool.handler({
      concurrency: 4,
      databases: Array.from({ length: 3 }, (_, index) => ({
        db_type: 'mysql', host: `db-${index}`, port: 3306 + index, username: 'root', name: `pre-${index}`,
      })),
    }, { actor: { userId: 7 } as any, signal: controller.signal } as any);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      status: 'warning',
      summary: '批量纳管完成：0 项成功，0 项失败，3 项已取消且尚未执行',
      data: { total: 3, succeeded: 0, failed: 0, cancelled: 3 },
      details: { terminal: true, retryable: false, failed: 0, cancelled: 3 },
    });
    expect((result.data as any).results).toEqual([
      expect.objectContaining({ index: 0, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false, name: 'pre-0' }),
      expect.objectContaining({ index: 1, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false }),
      expect.objectContaining({ index: 2, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false }),
    ]);
    expect(result.next_actions?.join('\n')).toContain('尚未执行');
    expect(result.next_actions?.join('\n')).not.toContain('retryable=true');
  });

  it('keeps a partial success and does not retry the batch after later items are cancelled', async () => {
    const controller = new AbortController();
    const handler = vi.spyOn(addDatabaseTool, 'handler').mockImplementation(async () => {
      controller.abort();
      return { success: true, data: { instanceId: 1, connectionStatus: 'connected' } };
    });
    const result = await addDatabaseBatchTool.handler({
      concurrency: 1,
      databases: Array.from({ length: 3 }, (_, index) => ({ db_type: 'mysql', host: `db-${index}`, port: 3306, username: 'root' })),
    }, { actor: { userId: 7 } as any, signal: controller.signal } as any);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      status: 'warning',
      data: {
        total: 3,
        succeeded: 1,
        failed: 0,
        cancelled: 2,
        results: [
          { index: 0, status: 'created', instanceId: 1, retryable: false },
          { index: 1, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false },
          { index: 2, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false },
        ],
      },
      details: { terminal: true, retryable: false, failed: 0, cancelled: 2 },
    });
    expect(result.summary).toBe('批量纳管完成：1 项成功，0 项失败，2 项已取消且尚未执行');
  });

  it('preserves a terminal failure and does not let cancellation mark the batch retryable', async () => {
    const controller = new AbortController();
    const handler = vi.spyOn(addDatabaseTool, 'handler').mockImplementation(async () => {
      controller.abort();
      return {
        success: false,
        error: '连接失败',
        errorCode: 'CONNECTION_FAILED',
        details: { terminal: true, retryable: false },
      };
    });
    const result = await addDatabaseBatchTool.handler({
      concurrency: 1,
      databases: Array.from({ length: 3 }, (_, index) => ({ db_type: 'mysql', host: `db-${index}`, port: 3400 + index, username: 'root' })),
    }, { actor: { userId: 7 } as any, signal: controller.signal } as any);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      data: {
        succeeded: 0,
        failed: 1,
        cancelled: 2,
        results: [
          { index: 0, status: 'failed', errorCode: 'CONNECTION_FAILED', retryable: false },
          { index: 1, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false },
          { index: 2, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false },
        ],
      },
      details: { terminal: true, retryable: false },
    });
    expect(result.next_actions?.join('\n')).toContain('不可重试');
    expect(result.next_actions?.join('\n')).toContain('尚未执行');
  });

  it('keeps in-flight success, exceptions, and unknown writes distinct from unstarted cancellations', async () => {
    const controller = new AbortController();
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: number[] = [];
    vi.spyOn(addDatabaseTool, 'handler').mockImplementation(async (args) => {
      const index = Number(args.port) - 3306;
      calls.push(index);
      started += 1;
      if (started === 3) {
        controller.abort();
        controller.abort();
      }
      await gate;
      if (index === 1) throw new Error('in-flight exception');
      if (index === 2) {
        return {
          success: false,
          error: '创建结果未知：先对账，不要直接重试',
          errorCode: 'CREATE_INSTANCE_FAILED',
          details: { terminal: true, retryable: false },
        };
      }
      return { success: true, data: { instanceId: 10 + index, connectionStatus: 'connected' } };
    });

    const pending = addDatabaseBatchTool.handler({
      concurrency: 3,
      databases: Array.from({ length: 5 }, (_, index) => ({
        db_type: 'mysql', host: `db-${index}`, port: 3306 + index, username: 'root', name: `live-${index}`,
      })),
    }, { actor: { userId: 7 } as any, signal: controller.signal } as any);
    await vi.waitFor(() => { if (started < 3) throw new Error('waiting for in-flight handlers'); });
    release();
    const result = await pending;

    expect(calls).toEqual([0, 1, 2]);
    expect(result).toMatchObject({
      success: true,
      status: 'warning',
      data: {
        total: 5,
        succeeded: 1,
        failed: 2,
        cancelled: 2,
        results: [
          { index: 0, status: 'created', instanceId: 10, retryable: false },
          { index: 1, status: 'failed', errorCode: 'BATCH_ITEM_FAILED', retryable: true },
          { index: 2, status: 'failed', errorCode: 'CREATE_INSTANCE_FAILED', retryable: false, reason: '创建结果未知：先对账，不要直接重试' },
          { index: 3, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false, name: 'live-3' },
          { index: 4, status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false, name: 'live-4' },
        ],
      },
      details: { terminal: false, retryable: true, failed: 2, cancelled: 2 },
    });
    expect(result.summary).toBe('批量纳管完成：1 项成功，2 项失败，2 项已取消且尚未执行');
    const guidance = result.next_actions?.join('\n') ?? '';
    expect(guidance).toContain('retryable=true');
    expect(guidance).toContain('不要重放已成功、已取消未执行或结果未知的条目');
    expect(guidance).toContain('status=cancelled');
    expect((result.data as any).results.filter((item: { status: string }) => item.status === 'cancelled')).toHaveLength(2);
  });
});

// #372 / OCR-0286: a completed side effect survives a finish failure in the response.
describe('batch idempotency recovery', () => {
  afterEach(() => vi.restoreAllMocks());
  const args = { concurrency: 1, databases: [0, 1].map(i => ({ db_type: 'mysql', host: `db-${i}`, port: 3306, username: 'root' })) };
  const context = { actor: { userId: 7 }, sessionId: 'recovery', idempotencyKey: 'key' } as any;
  it('returns all executed results and a non-retryable unconfirmed state when finish rejects', async () => {
    const { agentToolIdempotencyService: service } = await import('../../../security/agent-tool-idempotency-service.js');
    vi.spyOn(service, 'claim').mockResolvedValue({ kind: 'claimed', argumentsHash: 'hash', ownerToken: 'owner' });
    vi.spyOn(service, 'checkpoint').mockResolvedValue();
    vi.spyOn(service, 'finish').mockRejectedValue(new Error('lost acknowledgement'));
    const handler = vi.spyOn(addDatabaseTool, 'handler').mockResolvedValue({ success: true, data: { instanceId: 101 } });
    const result = await addDatabaseBatchTool.handler(args, context);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: true, errorCode: 'IDEMPOTENCY_RESULT_UNCONFIRMED', data: { succeeded: 2, results: [{ instanceId: 101 }, { instanceId: 101 }] }, details: { retryable: false, recoveryState: 'unknown' } });
  });
  it('does not start remaining items after a result checkpoint loses its acknowledgement', async () => {
    const { agentToolIdempotencyService: service } = await import('../../../security/agent-tool-idempotency-service.js');
    vi.spyOn(service, 'claim').mockResolvedValue({ kind: 'claimed', argumentsHash: 'hash', ownerToken: 'owner' });
    vi.spyOn(service, 'checkpoint').mockResolvedValueOnce().mockRejectedValue(new Error('unknown checkpoint'));
    const finish = vi.spyOn(service, 'finish');
    const handler = vi.spyOn(addDatabaseTool, 'handler').mockResolvedValue({ success: true, data: { instanceId: 101 } });
    const result = await addDatabaseBatchTool.handler(args, context);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ errorCode: 'IDEMPOTENCY_RESULT_UNCONFIRMED', data: { results: [{ instanceId: 101 }, { errorCode: 'IDEMPOTENCY_NOT_STARTED', retryable: false }] } });
  });
  it('exposes the interrupted checkpoint without calling any side effects', async () => {
    const { agentToolIdempotencyService: service } = await import('../../../security/agent-tool-idempotency-service.js');
    vi.spyOn(service, 'claim').mockResolvedValue({ kind: 'unknown', argumentsHash: 'hash', checkpoint: { items: { 0: { state: 'started' } } } });
    const handler = vi.spyOn(addDatabaseTool, 'handler');
    await expect(addDatabaseBatchTool.handler(args, context)).resolves.toMatchObject({ errorCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN', details: { retryable: false, checkpoint: { items: { 0: { state: 'started' } } } } });
    expect(handler).not.toHaveBeenCalled();
  });
});
