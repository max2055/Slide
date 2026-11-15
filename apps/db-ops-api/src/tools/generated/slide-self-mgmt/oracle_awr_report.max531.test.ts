import { afterEach, describe, expect, it, vi } from 'vitest';
const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: {} }));
import { oracleAwrReportTool as tool } from './oracle_awr_report.js';
const args = { instance_id: 531, begin_snap_id: 10, end_snap_id: 11 };
describe('MAX-531 / #286 AWR snapshot parameters', () => {
  afterEach(() => vi.resetAllMocks());
  it('binds snapshot IDs by the Oracle 19c signature and preserves native HTML', async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [[123]] })
      .mockResolvedValueOnce({ rows: [['<html>'], ['<body>A &amp; B</body>'], ['</html>']] });
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    expect(await tool.handler(args)).toMatchObject({ success: true, data: { html: '<html>\n<body>A &amp; B</body>\n</html>' } });
    expect(execute.mock.calls[1][0]).toContain('l_bid => :begin');
    expect(execute.mock.calls[1][0]).toContain('l_eid => :end');
    expect(execute.mock.calls[1][1]).toEqual({ dbid: 123, begin: 10, end: 11 });
  });
  it.each([10, 9])('rejects nonascending end=%s before database access', async end_snap_id => {
    expect(await tool.handler({ ...args, end_snap_id })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(databaseService.getConnection).not.toHaveBeenCalled();
  });
  it.each([
    ['ORA-20019: snapshot not found\nORA-06512: at SYS.DBMS_WORKLOAD_REPOSITORY', 'AWR_REPORT_FAILED'],
    ['ORA-01031: insufficient privileges', 'DIAGNOSTICS_PACK_REQUIRED'],
    ['ORA-00942: table or view does not exist', 'DIAGNOSTICS_PACK_REQUIRED'],
  ])('classifies %s', async (message, errorCode) => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [[123]] }).mockRejectedValueOnce(new Error(message));
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    expect(await tool.handler(args)).toMatchObject({ success: false, errorCode });
  });
});
