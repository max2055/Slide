import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Connection, Pool } from 'oracledb';
import { randomUUID } from 'node:crypto';

const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: {} }));

import { oracleTablespaceDetailTool as tool } from './oracle_tablespace_detail.js';

// Explicit opt-in only. The caller injects connection options; default collection reads no credentials.
describe.skipIf(process.env.SLIDE_MAX384_ORACLE !== '1')('MAX-384 / #613 real Oracle read-only acceptance', () => {
  let pool: Pool | undefined;
  let connection: Connection | undefined;

  beforeAll(async () => {
    if (!process.env.SLIDE_MAX384_ORACLE_CONFIG) throw new Error('SLIDE_MAX384_ORACLE_CONFIG is required');
    const config = JSON.parse(process.env.SLIDE_MAX384_ORACLE_CONFIG);
    if (!config.user || !config.password || !config.connectString) throw new Error('Explicit Oracle connection options are required');
    const { default: oracledb } = await import('oracledb');
    // Match the production pool's numeric fetch configuration and default array row format.
    pool = await oracledb.createPool({ ...config, fetchAsString: [oracledb.NUMBER],
      fetchAsBuffer: [oracledb.CLOB], poolMin: 0, poolMax: 1, queueTimeout: 10000 } as never);
    connection = await pool.getConnection();
    connection.callTimeout = 10000;
    console.log('MAX384 Oracle environment', { driver: oracledb.versionString,
      thin: oracledb.thin, server: connection.oracleServerVersionString });
  }, 20000);

  afterEach(() => vi.resetAllMocks());
  afterAll(async () => {
    const errors: unknown[] = [];
    try { await connection?.close(); } catch (error) { errors.push(error); }
    try { await pool?.close(0); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'MAX384 Oracle connection cleanup failed');
    console.log('MAX384 cleanup: connection and pool closed; database objects created=0, modified=0, deleted=0');
  }, 20000);

  it('executes the production DBA queries and maps existing tablespaces', async () => {
    const queryResults: unknown[][][] = [];
    const execute = vi.fn(async (sql: string, binds: Record<string, unknown>) => {
      try {
        const result = await connection!.execute(sql, binds);
        queryResults.push((result.rows || []) as unknown[][]);
        return result;
      } catch (error) {
        const oracleError = error as { code?: string; errorNum?: number };
        console.log('MAX384 production query failure', { code: oracleError.code, errorNum: oracleError.errorNum });
        throw error;
      }
    });
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    const result = await tool.handler({ instance_id: 384 });
    expect(result.success).toBe(true);
    const data = result.data as { tablespaces: Array<{ name: string; max_gb: number | null; free_gb: number | null }>; top_segments: Array<{ tablespace: string }> };
    expect(data.tablespaces.length).toBeGreaterThan(0);
    for (const ts of data.tablespaces) {
      expect(ts.max_gb === null || Number.isFinite(ts.max_gb)).toBe(true);
      expect(ts.free_gb === null || Number.isFinite(ts.free_gb)).toBe(true);
    }
    console.log('MAX384 production DBA mapping', data.tablespaces.map(({ name, max_gb, free_gb }) => ({ name, max_gb, free_gb })));
    console.log('MAX384 raw DBA values', queryResults[0].map(row => ({ name: row[0], max: row[8], autoextensible: row[9], type: typeof row[8] })));

    const name = data.tablespaces[0].name;
    const filtered = await tool.handler({ instance_id: 384, tablespace_name: name });
    expect(filtered).toMatchObject({ success: true, status: 'success', data: { tablespaces: [data.tablespaces[0]] } });
    const filteredData = filtered.data as typeof data;
    expect(filteredData.tablespaces).toHaveLength(1);
    expect(filteredData.top_segments.every(segment => segment.tablespace === name)).toBe(true);

    const missingName = `MAX384_${randomUUID().slice(0, 8)}`;
    expect(data.tablespaces.some(ts => ts.name === missingName)).toBe(false);
    const missing = await tool.handler({ instance_id: 384, tablespace_name: missingName });
    expect(missing).toMatchObject({ success: true, status: 'warning', data: {
      tablespaces: [], top_segments: [], summary: { total_tablespaces: 0, total_size_gb: 0, total_used_gb: 0 },
    } });
    expect(execute).toHaveBeenCalledTimes(6);
    // Successful raw results prove that the optional segment queries did not silently fall back.
    expect(queryResults).toHaveLength(6);
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      {}, {}, { ts_name: name }, { ts_name2: name }, { ts_name: missingName }, { ts_name2: missingName },
    ]);
    console.log('MAX384 DBA query ranges', { unfiltered: data.tablespaces.length,
      filteredName: name, filtered: filteredData.tablespaces.length, unmatched: 0, successfulQueries: queryResults.length });
  });

  it('R1 aggregates any YES across real read-only multi-file samples using the production SQL', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    await tool.handler({ instance_id: 384 });
    const overview = execute.mock.calls[0][0] as string;
    const aggregate = overview.match(/LEFT JOIN \(\s*(SELECT[\s\S]+?FROM dba_data_files d\s*GROUP BY tablespace_name)\s*\) d/);
    expect(aggregate).not.toBeNull();
    // Reuse the actual production aggregate; replace only its dictionary sources with DUAL samples.
    const sql = aggregate![1].replace(/\bdba_data_files\b/g, 'max384_files').replace(/\bdba_free_space\b/g, 'max384_free');
    const result = await connection!.execute(`WITH max384_files AS (
      SELECT 'ALL_NO' tablespace_name, 1 bytes, 2 maxbytes, 'NO' autoextensible FROM dual
      UNION ALL SELECT 'ALL_NO', 1, 2, 'NO' FROM dual
      UNION ALL SELECT 'ALL_YES', 1, 2, 'YES' FROM dual
      UNION ALL SELECT 'ALL_YES', 1, 2, 'YES' FROM dual
      UNION ALL SELECT 'MIXED_NO_YES', 1, 2, 'NO' FROM dual
      UNION ALL SELECT 'MIXED_NO_YES', 1, 2, 'YES' FROM dual
      UNION ALL SELECT 'MIXED_YES_NO', 1, 2, 'YES' FROM dual
      UNION ALL SELECT 'MIXED_YES_NO', 1, 2, 'NO' FROM dual
      UNION ALL SELECT 'SINGLE_YES', 1, 2, 'YES' FROM dual
    ), max384_free AS (
      SELECT CAST(NULL AS VARCHAR2(30)) tablespace_name, 0 bytes FROM dual WHERE 1 = 0
    ) SELECT tablespace_name, autoextensible FROM (${sql}) ORDER BY tablespace_name`);
    expect(result.rows).toEqual([
      ['ALL_NO', 'NO'], ['ALL_YES', 'YES'], ['MIXED_NO_YES', 'YES'], ['MIXED_YES_NO', 'YES'], ['SINGLE_YES', 'YES'],
    ]);
    console.log('MAX384 R1 production aggregate samples', result.rows);
  });

  it('maps real driver zero/null/nonzero projection rows through the production handler', async () => {
    // DUAL projections exercise SQL NVL/ROUND and driver decoding without creating tablespaces or files.
    const projection = await connection!.execute(`
      SELECT 'MAX384_ZERO', 'ONLINE', 'PERMANENT', 'LOCAL', 'SYSTEM', 0, 0, 0,
        ROUND(NVL(CAST(NULL AS NUMBER), 0) / 1024 / 1024 / 1024, 2), 'NO', 0 FROM dual
      UNION ALL
      SELECT 'MAX384_NULL', 'ONLINE', 'PERMANENT', 'LOCAL', 'SYSTEM', 0, 0, 0,
        CAST(NULL AS NUMBER), 'NO', 0 FROM dual
      UNION ALL
      SELECT 'MAX384_NONZERO', 'ONLINE', 'PERMANENT', 'LOCAL', 'SYSTEM', 4, 2.11, 0,
        12.34, 'YES', 0 FROM dual
      UNION ALL
      SELECT 'MAX384_FULL', 'ONLINE', 'PERMANENT', 'LOCAL', 'SYSTEM', 8, 8, 100,
        8, 'NO', 0 FROM dual`);
    const rows = projection.rows as unknown[][];
    expect(rows).toHaveLength(4);
    expect(Number(rows[0][8])).toBe(0);
    expect(rows[1][8]).toBeNull();
    expect(Number(rows[2][8])).toBe(12.34);
    console.log('MAX384 driver capacity types', rows.map(row => ({ name: row[0],
      max: row[8], type: row[8] === null ? 'null' : typeof row[8] })));

    // Only the overview rows are injected. The handler and optional segment SQL remain production code.
    const execute = vi.fn().mockResolvedValueOnce(projection)
      .mockImplementationOnce((sql, binds) => connection!.execute(sql, binds));
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    const result = await tool.handler({ instance_id: 384, tablespace_name: 'MAX384_PROJECTION_ONLY' });
    expect(result).toMatchObject({ success: true, data: { tablespaces: [
      { name: 'MAX384_ZERO', max_gb: 0, free_gb: 0 },
      { name: 'MAX384_NULL', max_gb: null, free_gb: null },
      { name: 'MAX384_NONZERO', max_gb: 12.34, free_gb: 10.23 },
      { name: 'MAX384_FULL', max_gb: 8, free_gb: 0 },
    ] } });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
