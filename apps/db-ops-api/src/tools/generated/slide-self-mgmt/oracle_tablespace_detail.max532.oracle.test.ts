import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Connection } from 'oracledb';

const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
import { oracleTablespaceDetailTool as tool } from './oracle_tablespace_detail.js';

// Explicit opt-in: default collection neither opens connections nor reads credentials.
describe.skipIf(process.env.SLIDE_MAX532_ORACLE !== '1')('MAX-532 / #287 real Oracle tablespace acceptance', () => {
  let admin: Connection | undefined;
  let restricted: Connection | undefined;
  let closed: Connection | undefined;
  let createdUser = false;
  const createdTablespaces: string[] = [];
  const prefix = `MAX532_${randomBytes(4).toString('hex').toUpperCase()}`;
  const names = [`${prefix}_NO`, `${prefix}_YES`, `${prefix}_MIXED`];
  const user = `${prefix}_USER`;

  beforeAll(async () => {
    if (!process.env.SLIDE_MAX532_ORACLE_CONFIG) throw new Error('SLIDE_MAX532_ORACLE_CONFIG is required');
    const config = JSON.parse(process.env.SLIDE_MAX532_ORACLE_CONFIG);
    if (!config.user || !config.password || !config.connectString) throw new Error('Explicit Oracle connection options are required');
    const { default: oracle } = await import('oracledb');
    admin = await oracle.getConnection(config);
    admin.callTimeout = 10000;
    console.log('MAX532 environment', { driver: oracle.versionString, thin: oracle.thin, server: admin.oracleServerVersionString });
    // Derive the server-side datafile directory; never assume a developer's filesystem path.
    const location = await admin.execute('SELECT file_name FROM dba_data_files WHERE ROWNUM = 1');
    const fileName = String((location.rows as string[][])[0][0]);
    if (!fileName.startsWith('/') || !fileName.includes('/')) throw new Error('Acceptance requires filesystem datafiles');
    const directory = fileName.slice(0, fileName.lastIndexOf('/') + 1).replaceAll("'", "''");
    for (const [index, name] of names.entries()) {
      await admin.execute(`CREATE TABLESPACE ${name} DATAFILE '${directory}${name}_1.dbf' SIZE 8M ${index === 1 ? 'AUTOEXTEND ON NEXT 1M MAXSIZE 16M' : 'AUTOEXTEND OFF'}`);
      createdTablespaces.push(name);
      if (index === 2) await admin.execute(`ALTER TABLESPACE ${name} ADD DATAFILE '${directory}${name}_2.dbf' SIZE 8M AUTOEXTEND ON NEXT 1M MAXSIZE 16M`);
    }
    const password = `A${randomBytes(12).toString('hex')}`;
    await admin.execute(`CREATE USER ${user} IDENTIFIED BY "${password}"`);
    createdUser = true;
    await admin.execute(`GRANT CREATE SESSION TO ${user}`);
    restricted = await oracle.getConnection({ ...config, user, password });
    restricted.callTimeout = 10000;
    closed = await oracle.getConnection(config);
    await closed.close();
  }, 60000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await restricted?.close(); } catch (error) { errors.push(error); }
    if (admin) {
      if (createdUser) try { await admin.execute(`DROP USER ${user} CASCADE`); } catch (error) { errors.push(error); }
      for (const name of createdTablespaces) {
        try { await admin.execute(`DROP TABLESPACE ${name} INCLUDING CONTENTS AND DATAFILES`); } catch (error) { errors.push(error); }
      }
      // Verify task objects are gone; leave shared objects untouched.
      try {
        const remaining = await admin.execute(`SELECT tablespace_name FROM dba_tablespaces WHERE tablespace_name IN (:a, :b, :c)
          UNION ALL SELECT username FROM dba_users WHERE username = :u`, { a: names[0], b: names[1], c: names[2], u: user });
        expect(remaining.rows).toEqual([]);
      } catch (error) { errors.push(error); }
      try { await admin.close(); } catch (error) { errors.push(error); }
    }
    vi.resetAllMocks();
    console.log('MAX532 cleanup', { tablespaces: createdTablespaces, user, errors: errors.length });
    if (errors.length) throw new AggregateError(errors, 'MAX532 cleanup failed');
  }, 60000);

  it('runs production SQL for single/multi-file tablespaces, mixed autoextend, bound and unmatched filters', async () => {
    const execute = vi.fn((sql, binds) => admin!.execute(sql, binds));
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    const all = await tool.handler({ instance_id: 532 });
    expect(all).toMatchObject({ success: true, status: 'success' });
    const tablespaces = (all.data as { tablespaces: Array<{ name: string; autoextensible: string; total_gb: number; max_gb: number }> }).tablespaces;
    for (const [index, name] of names.entries()) {
      const ts = tablespaces.find(row => row.name === name);
      expect(ts).toMatchObject({ name, autoextensible: index === 0 ? 'NO' : 'YES' });
      const filtered = await tool.handler({ instance_id: 532, tablespace_name: name });
      expect(filtered).toMatchObject({ success: true, status: 'success', data: { tablespaces: [ts] } });
      expect((filtered.data as { tablespaces: unknown[] }).tablespaces).toHaveLength(1);
    }
    const unmatched = await tool.handler({ instance_id: 532, tablespace_name: `${prefix}' OR '1'='1` });
    expect(unmatched).toMatchObject({ success: true, status: 'warning', data: { tablespaces: [], top_segments: [] } });
    expect(execute).toHaveBeenCalledTimes(10);
    expect(execute.mock.results.every(result => result.type === 'return')).toBe(true);
    console.log('MAX532 production handler results', tablespaces.filter(row => names.includes(row.name)));
  });

  it('reports actual dictionary privilege denial without recommending SYS/DBA login', async () => {
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: restricted });
    const result = await tool.handler({ instance_id: 532 });
    expect(result).toMatchObject({ success: false, errorCode: 'DBA_PRIVILEGE_REQUIRED' });
    expect(result.error).not.toMatch(/SYS|DBA 或/);
    console.log('MAX532 restricted user result', result);
  });

  it('classifies a real SQL parse failure and a real closed driver connection separately', async () => {
    const execute = vi.fn(() => admin!.execute('SELECT max532_missing_column FROM dual'));
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: { execute } });
    expect(await tool.handler({ instance_id: 532 })).toMatchObject({ success: false, errorCode: 'TABLESPACE_QUERY_FAILED' });
    databaseService.getConnection.mockReturnValue({ connected: true, db_type: 'oracle', oracleConnection: closed });
    expect(await tool.handler({ instance_id: 532 })).toMatchObject({ success: false, errorCode: 'TABLESPACE_CONNECTION_FAILED' });
    console.log('MAX532 real SQL and connection failure classifications passed');
  });
});
