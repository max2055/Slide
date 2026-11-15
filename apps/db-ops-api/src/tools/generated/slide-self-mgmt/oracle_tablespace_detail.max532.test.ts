import { afterEach, describe, expect, it, vi } from 'vitest';

const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
import { oracleTablespaceDetailTool as tool } from './oracle_tablespace_detail.js';

describe('MAX-532 / #287 Oracle tablespace failure classification', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

  it.each([
    [{ errorNum: 1031 }, 'DBA_PRIVILEGE_REQUIRED'],
    [{ code: 'ORA-00942' }, 'DBA_PRIVILEGE_REQUIRED'],
    [new Error('ORA-01031: insufficient privileges'), 'DBA_PRIVILEGE_REQUIRED'],
    [{ code: 'ECONNRESET' }, 'TABLESPACE_CONNECTION_FAILED'],
    [{ code: 'ORA-03113' }, 'TABLESPACE_CONNECTION_FAILED'],
    [{ errorNum: 3114 }, 'TABLESPACE_CONNECTION_FAILED'],
    [{ code: 'ORA-12514' }, 'TABLESPACE_CONNECTION_FAILED'],
    [{ code: 'NJS-500' }, 'TABLESPACE_CONNECTION_FAILED'],
    [{ code: 'DPI-1080' }, 'TABLESPACE_CONNECTION_FAILED'],
    [{ code: 'ETIMEDOUT' }, 'TABLESPACE_CONNECTION_FAILED'],
    [{ code: 'ORA-00904' }, 'TABLESPACE_QUERY_FAILED'],
    [{ errorNum: 979 }, 'TABLESPACE_QUERY_FAILED'],
    [{ code: 'ORA-00933' }, 'TABLESPACE_QUERY_FAILED'],
    [{ code: 'NJS-999' }, 'TABLESPACE_DETAIL_FAILED'],
    [{ code: 'ORA-01031\npassword=private' }, 'TABLESPACE_DETAIL_FAILED'],
    [new Error('private text mentions ORA-01031'), 'TABLESPACE_DETAIL_FAILED'],
    [null, 'TABLESPACE_DETAIL_FAILED'],
  ])('classifies %j as %s without leaking raw details', async (error, errorCode) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error('password=private user/secret@host SQL SELECT sensitive'), error));
    // Preserve null and Error cases instead of coercing them into a driver error shape.
    if (error === null || error instanceof Error) execute.mockRejectedValue(error);
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    const result = await tool.handler({ instance_id: 532 });
    expect(result).toMatchObject({ success: false, status: 'error', errorCode });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const output = JSON.stringify([result, warn.mock.calls]);
    expect(output).not.toMatch(/private|secret|sensitive|password|user\//);
    if (errorCode !== 'DBA_PRIVILEGE_REQUIRED') expect(result.error).not.toMatch(/授予|SYS|权限/);
  });

  it('sanitizes failures outside execute as well', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    databaseService.getConnection.mockImplementation(() => { throw new Error('password=private'); });
    const result = await tool.handler({ instance_id: 532 });
    expect(result).toMatchObject({ success: false, errorCode: 'TABLESPACE_DETAIL_FAILED' });
    expect(JSON.stringify([result, warn.mock.calls])).not.toContain('private');
  });

  it('keeps the overview and reports optional segment failure as a warning', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execute = vi.fn().mockResolvedValueOnce({ rows: [
      ['USERS', 'ONLINE', 'PERMANENT', 'LOCAL', 'SYSTEM', 1, 0, 0, 2, 'YES', 0],
    ] }).mockRejectedValueOnce({ code: 'ECONNRESET', message: 'private' });
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    expect(await tool.handler({ instance_id: 532 })).toMatchObject({ success: true, status: 'warning',
      data: { tablespaces: [{ name: 'USERS', autoextensible: 'YES' }], top_segments: [] },
      details: { top_segments_error: { errorCode: 'TABLESPACE_CONNECTION_FAILED' } } });
  });
});
