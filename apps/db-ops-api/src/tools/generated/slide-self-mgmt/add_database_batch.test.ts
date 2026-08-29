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

  it('marks unstarted items as cancelled when the signal is aborted', async () => {
    const controller = new AbortController();
    vi.spyOn(addDatabaseTool, 'handler').mockImplementation(async () => {
      controller.abort();
      return { success: true, data: { instanceId: 1 } };
    });
    const result = await addDatabaseBatchTool.handler({
      concurrency: 1,
      databases: Array.from({ length: 3 }, (_, index) => ({ db_type: 'mysql', host: `db-${index}`, port: 3306, username: 'root' })),
    }, { actor: { userId: 7 } as any, signal: controller.signal } as any);
    expect((result.data as any)?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 1, errorCode: 'BATCH_CANCELLED', retryable: true }),
      expect.objectContaining({ index: 2, errorCode: 'BATCH_CANCELLED', retryable: true }),
    ]));
  });
});
