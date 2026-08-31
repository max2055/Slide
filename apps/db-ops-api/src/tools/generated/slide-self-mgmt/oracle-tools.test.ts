import { describe, expect, it, vi } from 'vitest';

const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));

import { oracleAshReportTool } from './oracle_ash_report.js';
import { oracleAwrReportTool } from './oracle_awr_report.js';
import { oracleTablespaceDetailTool } from './oracle_tablespace_detail.js';

describe('Oracle diagnostic tool guardrails', () => {
  it('rejects reversed or oversized ASH time ranges before opening a query', async () => {
    const reversed = await oracleAshReportTool.handler({ instance_id: 1, start_time: '2026-01-02T00:00:00Z', end_time: '2026-01-01T00:00:00Z' });
    expect(reversed).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });

    const oversized = await oracleAshReportTool.handler({ instance_id: 1, start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-10T00:00:00Z' });
    expect(oversized).toMatchObject({ success: false, errorCode: 'TIME_RANGE_TOO_LARGE' });
    expect(databaseService.getConnection).not.toHaveBeenCalled();
  });

  it('rejects reversed AWR snapshots and invalid tablespace filters', async () => {
    const awr = await oracleAwrReportTool.handler({ instance_id: 1, begin_snap_id: 20, end_snap_id: 10 });
    expect(awr).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });

    const tablespace = await oracleTablespaceDetailTool.handler({ instance_id: 1, tablespace_name: '   ' });
    expect(tablespace).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
  });
});
