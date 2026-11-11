import { afterEach, describe, expect, it, vi } from 'vitest';

const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: {} }));

import { oracleTablespaceDetailTool as tool } from './oracle_tablespace_detail.js';

describe('MAX-384 / #613 Oracle tablespace capacity mapping', () => {
  afterEach(() => vi.resetAllMocks());

  it.each([
    { max: 0, used: 0, expectedMax: 0, expectedFree: 0 },
    { max: null, used: 0, expectedMax: null, expectedFree: null },
    { max: undefined, used: 0, expectedMax: null, expectedFree: null },
    { max: 12.34, used: 2.11, expectedMax: 12.34, expectedFree: 10.23 },
    { max: 8, used: 8, expectedMax: 8, expectedFree: 0 },
    { max: '0', used: '0', expectedMax: 0, expectedFree: 0 },
    { max: '12.34', used: '2.11', expectedMax: 12.34, expectedFree: 10.23 },
  ])('preserves max=$max and calculates free capacity with used=$used', async ({ max, used, expectedMax, expectedFree }) => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [['MAX384', 'ONLINE', 'PERMANENT', 'LOCAL', 'SYSTEM', 4, used, 0, max, 'YES', 0]] })
      .mockResolvedValueOnce({ rows: [] });
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });

    const result = await tool.handler({ instance_id: 384, tablespace_name: 'MAX384' });
    expect(result).toMatchObject({ success: true, status: 'success', data: {
      tablespaces: [{ name: 'MAX384', max_gb: expectedMax, free_gb: expectedFree }],
      top_segments: [], summary: { total_tablespaces: 1, total_size_gb: 4, total_used_gb: Number(used) },
    } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toEqual({ ts_name: 'MAX384' });
    expect(execute.mock.calls[1][1]).toEqual({ ts_name2: 'MAX384' });
  });
});
