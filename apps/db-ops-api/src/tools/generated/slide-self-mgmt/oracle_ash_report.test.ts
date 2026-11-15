import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
import { oracleAshReportTool as tool } from './oracle_ash_report.js';

const args = { instance_id: 534, start_time: '2026-05-19 10:00:00', end_time: '2026-05-19T11:00:00' };
const identity = [123456, 'ORCL', 2, 'orcl2', 'ORCLPDB1', '+08:00', '+00:00', '+08:00'];
const execute = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
  execute.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValue({ rows: [['<html>'], ['original report'], ['</html>']] });
});

describe('MAX-534 / #391 connected Oracle instance identity', () => {
  it('binds the actual non-1 instance with database/container identity and correct Oracle parameter names', async () => {
    const result = await tool.handler(args);
    expect(result).toMatchObject({ success: true, data: { dbid: 123456, database_name: 'ORCL', instance_number: 2, instance_name: 'orcl2', container_name: 'ORCLPDB1', instance_id: 534, target_strategy: 'connected_instance', html: '<html>\noriginal report\n</html>' } });
    expect(result.summary).toContain('ORCL/orcl2');
    expect(execute.mock.calls[0][0]).toContain('V$INSTANCE');
    const [sql, binds] = execute.mock.calls[1];
    expect(sql).toContain('l_inst_num => :b_instance_number');
    expect(sql).toContain('l_btime => TO_DATE');
    expect(sql).toContain('l_etime => TO_DATE');
    expect(sql).not.toContain('l_bnstime');
    expect(binds).toEqual({ b_dbid: 123456, b_instance_number: 2, b_start_time: '2026-05-19 10:00:00', b_end_time: '2026-05-19 11:00:00' });
  });

  it.each([[], [0, 'ORCL', 2, 'orcl2'], [123, 'ORCL', 0, 'orcl'], [123, 'ORCL', 1.5, 'orcl'], [123, '', 1, 'orcl'], [123, 'ORCL', 1, '']])('fails closed for unavailable/malformed identity: %j', async (...row) => {
    execute.mockReset().mockResolvedValue({ rows: [row] });
    expect(await tool.handler(args)).toMatchObject({ success: false, errorCode: 'ASH_IDENTITY_UNAVAILABLE' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retains identity and time semantics for an empty report', async () => {
    execute.mockReset().mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: [[null], ['']] });
    expect(await tool.handler(args)).toMatchObject({ success: true, status: 'warning', data: { html: '', instance_number: 2, dbid: 123456, time_semantics: 'database_wall_clock' } });
  });

  it('keeps concurrent reports attached to their own connection and instance identity', async () => {
    const secondIdentity = [999, 'OTHERDB', 3, 'other3', 'OTHERPDB', '+00:00', '+00:00', '+00:00'];
    const otherExecute = vi.fn().mockResolvedValueOnce({ rows: [secondIdentity] }).mockResolvedValueOnce({ rows: [['other report']] });
    databaseService.getConnection.mockImplementation(id => ({ connected: true, db_type: 'oracle', oracleConnection: { execute: id === 534 ? execute : otherExecute } }));
    const [first, second] = await Promise.all([tool.handler(args), tool.handler({ ...args, instance_id: 535 })]);
    expect(first).toMatchObject({ success: true, data: { instance_id: 534, instance_number: 2, dbid: 123456 } });
    expect(second).toMatchObject({ success: true, data: { instance_id: 535, instance_number: 3, dbid: 999, html: 'other report' } });
    expect(otherExecute.mock.calls[1][1]).toMatchObject({ b_dbid: 999, b_instance_number: 3 });
  });

  it('keeps the captured connection when the managed connection is replaced during identity lookup', async () => {
    const replacement = { execute: vi.fn() };
    const conn = { connected: true, db_type: 'oracle', oracleConnection: { execute } };
    databaseService.getConnection.mockReturnValue(conn);
    execute.mockReset().mockImplementationOnce(async () => {
      conn.oracleConnection = replacement;
      return { rows: [identity] };
    }).mockResolvedValueOnce({ rows: [['same connection']] });
    expect(await tool.handler(args)).toMatchObject({ success: true, data: { instance_number: 2, html: 'same connection' } });
    expect(replacement.execute).not.toHaveBeenCalled();
  });

  it.each(['instance_number', 'dbid', 'target_instance', 'Instance_Number'])('rejects unsupported target override %s before connection access', async key => {
    expect(await tool.handler({ ...args, [key]: 1 })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(databaseService.getConnection).not.toHaveBeenCalled();
  });

  it.each([undefined, { connected: false }, { connected: true, db_type: 'mysql' }])('preserves connection guards: %j', async conn => {
    databaseService.getConnection.mockReturnValue(conn);
    expect(await tool.handler(args)).toMatchObject({ success: false, errorCode: conn?.connected ? 'WRONG_DB_TYPE' : 'NOT_CONNECTED' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('MAX-535 / #392 database wall-clock contract', () => {
  const originalTimezone = process.env.TZ;
  afterEach(() => { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone; });

  it.each(['UTC', 'Asia/Shanghai'])('keeps the same seconds and binds in API TZ=%s', async timezone => {
    process.env.TZ = timezone;
    expect(await tool.handler(args)).toMatchObject({ success: true, data: { start_time: '2026-05-19 10:00:00', end_time: '2026-05-19 11:00:00', time_semantics: 'database_wall_clock', session_timezone: '+08:00', database_timezone: '+00:00', database_host_current_offset: '+08:00' } });
    expect(execute.mock.calls[1][1].b_start_time).toBe('2026-05-19 10:00:00');
  });

  // ASH takes DATE: offsets/precision cannot be silently discarded. Callers must
  // explicitly provide the intended database clock reading instead.
  it.each(['2026-05-19T10:00:00Z', '2026-05-19T10:00:00+08:00', '2026-05-19T02:00:00-06:00', '2026-05-19 10:00:00.001', '2026-02-29 10:00:00', '2026-04-31 10:00:00', '2026-05-19 24:00:00', '2026-05-19 10:60:00', '2026-05-19 10:00:60', '0000-01-01 00:00:00', '', null, 1779184800000, "2026-05-19 10:00:00' OR 1=1"] )('rejects ambiguous or invalid input %j before connection access', async start_time => {
    expect(await tool.handler({ ...args, start_time })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(databaseService.getConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-05-19 10:00:00', '2026-05-19 10:00:00', 'INVALID_ARGUMENTS'],
    ['2026-05-19 10:00:00', '2026-05-19 09:00:00', 'INVALID_ARGUMENTS'],
    ['2026-05-19 10:00:00', '2026-05-26 10:00:01', 'TIME_RANGE_TOO_LARGE'],
  ])('rejects invalid range %s to %s', async (start_time, end_time, errorCode) => {
    expect(await tool.handler({ ...args, start_time, end_time })).toMatchObject({ success: false, errorCode });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([['2024-02-29 10:00:00', '2024-03-07 10:00:00'], ['2026-03-08 01:00:00', '2026-03-15 01:00:00']])('accepts leap-day and exact 7-day wall-clock ranges', async (start_time, end_time) => {
    expect(await tool.handler({ ...args, start_time, end_time })).toMatchObject({ success: true });
  });
});

describe('MAX-548 / #612 preserve Oracle diagnostics without inferring licenses', () => {
  it.each([
    ['ORA-00942: table or view does not exist', 'ORA-00942'],
    ['ORA-01031: insufficient privileges', 'ORA-01031'],
    ['ORA-06550: line 1\nPLS-00201: identifier DBMS_WORKLOAD_REPOSITORY must be declared', 'ORA-06550'],
    ['ORA-06553: PLS-306: wrong number or types of arguments in call to ASH_REPORT_HTML', 'ORA-06553'],
    ['NJS-098: invalid bind', 'NJS-098'],
    ['insufficient privileges for DBMS_WORKLOAD_REPOSITORY', 'ASH_REPORT_FAILED'],
    ['DBMS_WORKLOAD_REPOSITORY: unknown failure', 'ASH_REPORT_FAILED'],
  ])('retains %s', async (message, errorCode) => {
    execute.mockReset().mockRejectedValueOnce(new Error(message));
    expect(await tool.handler(args)).toMatchObject({ success: false, errorCode, error: `获取 ASH 报告失败：${message}` });
  });

  it('retains report-stage errors and can recover on a subsequent explicit invocation', async () => {
    execute.mockReset().mockResolvedValueOnce({ rows: [identity] }).mockRejectedValueOnce(new Error('ORA-01031: insufficient privileges'));
    expect(await tool.handler(args)).toMatchObject({ success: false, errorCode: 'ORA-01031' });
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: [['recovered']] });
    expect(await tool.handler(args)).toMatchObject({ success: true, data: { html: 'recovered' } });
  });
});
