import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: {} }));
import { oracleAwrReportTool as tool } from './oracle_awr_report.js';
// Explicit opt-in; default test collection never reads local credentials.
describe.skipIf(process.env.SLIDE_MAX531_ORACLE !== '1')('MAX-531 real Oracle read-only acceptance', () => {
  it('checks ALL_ARGUMENTS, generates native HTML and rejects nonexistent snapshots', async () => {
    if (!process.env.SLIDE_MAX531_ORACLE_CONFIG) throw new Error('Explicit Oracle configuration required');
    const { default: oracle } = await import('oracledb');
    const connection = await oracle.getConnection(JSON.parse(process.env.SLIDE_MAX531_ORACLE_CONFIG));
    connection.callTimeout = 30000;
    try {
      console.log('Oracle version', connection.oracleServerVersionString);
      const signature = await connection.execute("SELECT argument_name FROM all_arguments WHERE owner='SYS' AND package_name='DBMS_WORKLOAD_REPOSITORY' AND object_name='AWR_REPORT_HTML' AND position > 0 ORDER BY sequence");
      console.log('ALL_ARGUMENTS', signature.rows);
      expect(signature.rows).toEqual([['L_DBID'], ['L_INST_NUM'], ['L_BID'], ['L_EID'], ['L_OPTIONS']]);
      const snaps = await connection.execute(`SELECT snap_id FROM dba_hist_snapshot WHERE dbid=(SELECT dbid FROM v$database) AND instance_number=1 AND startup_time=(SELECT MAX(startup_time) FROM dba_hist_snapshot WHERE instance_number=1) ORDER BY snap_id DESC FETCH FIRST 2 ROWS ONLY`);
      console.log('Existing snapshots', snaps.rows);
      expect(snaps.rows?.length).toBe(2);
      const end = Number((snaps.rows![0] as number[])[0]);
      const begin = Number((snaps.rows![1] as number[])[0]);
      databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: connection });
      const result = await tool.handler({ instance_id: 531, begin_snap_id: begin, end_snap_id: end });
      expect(result.success).toBe(true);
      const html = (result.data as { html: string }).html;
      expect(html).toMatch(/<html/i);
      expect(html).toMatch(/<\/html>/i);
      if (process.env.SLIDE_MAX531_HTML_OUTPUT) await writeFile(process.env.SLIDE_MAX531_HTML_OUTPUT, html);
      console.log('Native HTML success', { begin, end, bytes: Buffer.byteLength(html) });
      const invalid = await tool.handler({ instance_id: 531, begin_snap_id: 2000000000, end_snap_id: 2000000001 });
      console.log('Nonexistent snapshots', invalid);
      expect(invalid).toMatchObject({ success: false, errorCode: 'AWR_REPORT_FAILED' });
    } finally { await connection.close(); console.log('Connection closed; no database objects modified'); }
  }, 60000);
  it('reports an actual restricted Oracle user permission failure', async () => {
    if (!process.env.SLIDE_MAX531_ORACLE_CONFIG) throw new Error('Explicit Oracle configuration required');
    const { default: oracle } = await import('oracledb');
    const config = JSON.parse(process.env.SLIDE_MAX531_ORACLE_CONFIG);
    const admin = await oracle.getConnection(config);
    const user = `C##MAX531_${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const password = `X${randomUUID().replaceAll('-', '').slice(0, 23)}`;
    let created = false;
    let restricted: import('oracledb').Connection | undefined;
    try {
      await admin.execute(`CREATE USER ${user} IDENTIFIED BY "${password}"`);
      created = true;
      await admin.execute(`GRANT CREATE SESSION TO ${user}`);
      restricted = await oracle.getConnection({ ...config, user, password });
      databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: restricted });
      const result = await tool.handler({ instance_id: 531, begin_snap_id: 1, end_snap_id: 2 });
      expect(result).toMatchObject({ success: false, errorCode: 'DIAGNOSTICS_PACK_REQUIRED' });
    } finally {
      await restricted?.close();
      try { if (created) await admin.execute(`DROP USER ${user} CASCADE`); }
      finally { await admin.close(); }
    }
  }, 30000);
});
