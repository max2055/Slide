import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Connection } from 'oracledb';

const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
import { oracleAshReportTool as tool } from './oracle_ash_report.js';

// Explicit opt-in. No developer paths, credentials or shared DB are read by
// default collection. Missing configuration must fail an opted-in run.
describe.skipIf(process.env.SLIDE_MAX534_ORACLE !== '1')('MAX-534/535/548 real Oracle ASH acceptance', () => {
  let admin: Connection | undefined;
  let restricted: Connection | undefined;
  let createdUser = false;
  const user = `MAX534_${randomBytes(4).toString('hex').toUpperCase()}`;
  let start_time: string;
  let end_time: string;
  let identity: unknown[];

  beforeAll(async () => {
    if (!process.env.SLIDE_MAX534_ORACLE_CONFIG) throw new Error('SLIDE_MAX534_ORACLE_CONFIG is required');
    const config = JSON.parse(process.env.SLIDE_MAX534_ORACLE_CONFIG);
    if (!config.user || !config.password || !config.connectString) throw new Error('Explicit Oracle connection options are required');
    const { default: oracle } = await import('oracledb');
    admin = await oracle.getConnection(config);
    admin.callTimeout = 15000;
    const environment = await admin.execute(`SELECT d.dbid, d.name, i.instance_number, i.instance_name,
      SYS_CONTEXT('USERENV', 'SERVICE_NAME'), SESSIONTIMEZONE, DBTIMEZONE,
      TO_CHAR(SYSTIMESTAMP, 'TZH:TZM'), i.parallel FROM V$DATABASE d CROSS JOIN V$INSTANCE i`);
    identity = (environment.rows as unknown[][])[0];
    console.log('MAX534 environment', { driver: oracle.versionString, thin: oracle.thin, server: admin.oracleServerVersionString, identity });
    if (process.env.SLIDE_MAX534_REQUIRE_RAC === '1') {
      expect(identity[8]).toBe('YES');
      expect(Number(identity[2])).toBeGreaterThan(1);
    }
    const range = await admin.execute(`SELECT TO_CHAR(SYSDATE - 1/24, 'YYYY-MM-DD HH24:MI:SS'),
      TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') FROM dual`);
    [start_time, end_time] = (range.rows as string[][])[0];
    const password = `A${randomBytes(12).toString('hex')}`;
    await admin.execute(`CREATE USER ${user} IDENTIFIED BY "${password}"`);
    createdUser = true;
    await admin.execute(`GRANT CREATE SESSION TO ${user}`);
    restricted = await oracle.getConnection({ ...config, user, password });
    restricted.callTimeout = 15000;
  }, 30000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await restricted?.close(); } catch (error) { errors.push(error); }
    if (admin) {
      if (createdUser) try { await admin.execute(`DROP USER ${user}`); } catch (error) { errors.push(error); }
      try {
        const remaining = await admin.execute('SELECT username FROM dba_users WHERE username = :u', { u: user });
        expect(remaining.rows).toEqual([]);
      } catch (error) { errors.push(error); }
      try { await admin.close(); } catch (error) { errors.push(error); }
    }
    vi.resetAllMocks();
    console.log('MAX534 cleanup', { user, errors: errors.length });
    if (errors.length) throw new AggregateError(errors, 'MAX534 cleanup failed');
  }, 30000);

  it('generates native HTML for the actual connected instance', async () => {
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: admin });
    const result = await tool.handler({ instance_id: 534, start_time, end_time });
    if (!result.success) console.log('MAX534 report failure', result);
    expect(result, result.error).toMatchObject({ success: true, data: { dbid: identity[0], database_name: identity[1], instance_number: identity[2], instance_name: identity[3], service_name: identity[4], time_semantics: 'database_wall_clock', start_time, end_time } });
    const data = result.data as { html: string };
    expect(data.html).toMatch(/<html/i);
    expect(data.html).toContain(String(identity[0]));
    expect(data.html.toLowerCase()).toContain(String(identity[3]).toLowerCase());
    console.log('MAX534 native report', { status: result.status, dbid: identity[0], instanceNumber: identity[2], htmlBytes: Buffer.byteLength(data.html), start_time, end_time });
  }, 30000);

  it('uses identical wall-clock binds under UTC/+08 session and API timezones, without session mutation by the handler', async () => {
    const originalTZ = process.env.TZ;
    const oldSession = await admin!.execute('SELECT SESSIONTIMEZONE FROM dual');
    const sessionTimezone = (oldSession.rows as string[][])[0][0];
    const calls: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (sql: string, binds?: Record<string, unknown>) => {
      if (binds) calls.push(binds);
      return admin!.execute(sql, binds || {});
    });
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    try {
      for (const apiTimezone of ['UTC', 'Asia/Shanghai']) {
        process.env.TZ = apiTimezone;
        for (const session of ['+00:00', '+08:00']) {
          await admin!.execute(`ALTER SESSION SET TIME_ZONE = '${session}'`);
          const result = await tool.handler({ instance_id: 534, start_time, end_time });
          if (!result.success) console.log('MAX535 report failure', result);
          expect(result, result.error).toMatchObject({ success: true, data: { start_time, end_time, session_timezone: session } });
          const current = await admin!.execute('SELECT SESSIONTIMEZONE FROM dual');
          expect((current.rows as string[][])[0][0]).toBe(session);
          // Derive absolute instants from the actual database host clock, never
          // from the API/session/storage timezone.
          const utc = await admin!.execute(`SELECT
            TO_CHAR(FROM_TZ(TO_TIMESTAMP(:s, 'YYYY-MM-DD HH24:MI:SS'), :z) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
            TO_CHAR(FROM_TZ(TO_TIMESTAMP(:e, 'YYYY-MM-DD HH24:MI:SS'), :z) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') FROM dual`,
            { s: start_time, e: end_time, z: String(identity[7]) });
          const [utcStart, utcEnd] = (utc.rows as string[][])[0];
          const expectedEnd = new Date(Date.parse(end_time.replace(' ', 'T') + 'Z') + 1000).toISOString().slice(0, 19).replace('T', ' ');
          for (const [minutes, offset] of [[0, 'Z'], [480, '+08:00'], [-360, '-06:00']] as const) {
            const shifted = (value: string, fraction: string) => new Date(Date.parse(value + 'Z') + minutes * 60000).toISOString().slice(0, 19) + fraction + offset;
            const absolute = await tool.handler({ instance_id: 534, start_time: shifted(utcStart, '.123456789'), end_time: shifted(utcEnd, '.456789123') });
            expect(absolute, absolute.error).toMatchObject({ success: true, data: { start_time, end_time: expectedEnd,
              converted_start_time: start_time + '.123456789', converted_end_time: end_time + '.456789123',
              start_input_semantics: 'absolute', conversion_time_zone: identity[7], session_timezone: session } });
          }
          console.log('MAX535 real timezone case', { apiTimezone, session, start_time, end_time, absoluteOffsets: ['Z', '+08:00', '-06:00'], fractions: '9 digits preserved; range outward to seconds' });
        }
      }
      const reportCalls = calls.filter(binds => 'b_start_time' in binds);
      expect(reportCalls).toHaveLength(16);
      expect(reportCalls.every(binds => binds.b_start_time === start_time)).toBe(true);
      expect(execute.mock.calls.every(([sql]) => !sql.includes('ALTER SESSION'))).toBe(true);
    } finally {
      if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
      await admin!.execute(`ALTER SESSION SET TIME_ZONE = '${sessionTimezone.replaceAll("'", "''")}'`);
    }
  }, 60000);

  it('applies Oracle historical region rules and validates mixed inputs with real SQL', async () => {
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: admin });
    // This tests the caller-declared conversion zone, not a claim that the host
    // itself runs in London or that a cluster was tested.
    for (const [date, hour] of [['2026-01-19', '10'], ['2026-07-19', '11']]) {
      const result = await tool.handler({ instance_id: 534, start_time: `${date}T10:00:00.25Z`, end_time: `${date} 12:00:00.5`, database_time_zone: 'Europe/London' });
      expect(result, result.error).toMatchObject({ success: true, data: { converted_start_time: `${date} ${hour}:00:00.250000000`,
        start_time: `${date} ${hour}:00:00`, end_time: `${date} 12:00:01`, conversion_time_zone: 'Europe/London', end_input_semantics: 'database_wall_clock' } });
    }
    const subsecond = await tool.handler({ instance_id: 534, start_time: start_time + '.000000001', end_time: start_time + '.000000002' });
    expect(subsecond).toMatchObject({ success: true, data: { start_time, converted_start_time: start_time + '.000000001' } });
    const invalid = await tool.handler({ instance_id: 534, start_time: '2026-05-19T04:00:00Z', end_time: '2026-05-19 03:00:00', database_time_zone: '+00:00' });
    expect(invalid).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    console.log('MAX535 region, mixed and nanosecond acceptance', { winterHour: '10', summerHour: '11', subsecond: subsecond.success, invalid: invalid.errorCode });
  }, 30000);

  it('preserves real dictionary denial, package denial and driver connection errors', async () => {
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: restricted });
    const dictionaryDenied = await tool.handler({ instance_id: 534, start_time, end_time });
    expect(dictionaryDenied).toMatchObject({ success: false, errorCode: 'ORA-00942' });
    expect(dictionaryDenied.error).toContain('ORA-00942');
    // Only this task user is altered. Do not change SYSTEM or shared grants.
    await admin!.execute(`GRANT SELECT_CATALOG_ROLE TO ${user}`);
    await restricted!.execute('SET ROLE SELECT_CATALOG_ROLE');
    // Prove this next failure occurs in the report phase, not identity lookup.
    expect((await restricted!.execute('SELECT dbid FROM V$DATABASE')).rows).toHaveLength(1);
    expect((await restricted!.execute('SELECT instance_number FROM V$INSTANCE')).rows).toHaveLength(1);
    const packageDenied = await tool.handler({ instance_id: 534, start_time, end_time });
    expect(packageDenied.success).toBe(false);
    expect(packageDenied.errorCode).not.toBe('DIAGNOSTICS_PACK_REQUIRED');
    expect(packageDenied.error).toMatch(/ORA-|PLS-/);
    const closed = restricted!;
    await restricted!.close();
    restricted = undefined;
    // Use the closed connection in a dedicated handle; no network retry.
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: closed });
    const disconnected = await tool.handler({ instance_id: 534, start_time, end_time });
    expect(disconnected.success).toBe(false);
    expect(disconnected.error).toMatch(/NJS-|DPI-/);
    console.log('MAX548 real errors', { dictionaryDenied, packageDenied, disconnected });
  }, 30000);
});
