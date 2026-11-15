/** Explicit opt-in: MAX543_REAL=1 MAX543_PROFILES=<external JSON>. */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql, { type Pool } from 'mysql2/promise';
import oracledb from 'oracledb';
import dmdb from 'dmdb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { schemaDatabaseService } from './schema-database-service.js';
import { schemaService } from './schema-service.js';

const enabled = process.env.MAX543_REAL === '1';
describe.skipIf(!enabled)('MAX-543 #557/#558 real Oracle + Dameng to MySQL snapshots', () => {
  const suffix = randomBytes(5).toString('hex').toUpperCase();
  const owner = `M543_${suffix}`;
  const schema = `max543_${suffix.toLowerCase()}`;
  const password = `T${randomBytes(10).toString('hex')}a1`;
  let root: Pool;
  let storage: Pool;
  let profiles: any;
  const admins: any[] = [];
  const sessions: any[] = [];
  const createdUsers: { admin: any; name: string }[] = [];
  beforeAll(async () => {
    if (!process.env.MAX543_PROFILES) throw new Error('MAX543_PROFILES is required');
    profiles = JSON.parse(await readFile(process.env.MAX543_PROFILES, 'utf8'));
    const p = profiles['mysql-test'];
    root = mysql.createPool({ host: p.host, port: p.port, user: p.user, password: p.password, connectionLimit: 2 });
    await root.query(`CREATE DATABASE ${schema}`);
    storage = mysql.createPool({ host: p.host, port: p.port, user: p.user, password: p.password, database: schema, connectionLimit: 2 });
    // Use production table definitions; no migrations or writes in shared schemas.
    const ddl = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    for (const table of ['database_instances', 'schema_snapshots']) {
      const statement = ddl.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '` \\([\\s\\S]*?;'))?.[0];
      if (!statement) throw new Error(`Missing production DDL for ${table}`);
      await storage.query(statement);
    }
    await storage.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (1,'max543','127.0.0.1',1,'fixture','fixture')");
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(storage);
    vi.spyOn(instanceDatabaseService, 'getInstanceById').mockResolvedValue({ username: owner } as any);
    console.log('MySQL version:', (await storage.query<any[]>('SELECT VERSION() AS version'))[0][0].version);
  }, 30000);
  afterAll(async () => {
    vi.restoreAllMocks();
    const cleanupErrors: unknown[] = [];
    for (const session of sessions) try { await session.close(); } catch (e) { cleanupErrors.push(e); }
    for (const { admin, name } of createdUsers) try { await admin.execute(`DROP USER ${name} CASCADE`); } catch (e) { cleanupErrors.push(e); }
    for (const admin of admins) try { await admin.close(); } catch (e) { cleanupErrors.push(e); }
    await storage?.end();
    if (root) {
      try { await root.query(`DROP DATABASE IF EXISTS ${schema}`); } finally { await root.end(); }
    }
    console.log('Cleanup:', cleanupErrors.length === 0 ? 'owned users/schemas removed' : `${cleanupErrors.length} failures`);
    expect(cleanupErrors).toEqual([]);
  }, 30000);

  for (const kind of ['oracle', 'dameng'] as const) {
    it(`${kind}: real dictionary precision, character semantics and persisted change detection`, async () => {
      const p = profiles[kind === 'oracle' ? 'oracle-test' : 'dameng-test'];
      const connectString = kind === 'oracle'
        ? `${p.host}:${p.port}/${p.service || p.serviceName}` : `${p.host}:${p.port}`;
      const connect = (user: string, secret: string): Promise<any> => kind === 'oracle'
        ? oracledb.getConnection({ user, password: secret, connectString })
        : dmdb.getConnection({ user, password: secret, connectString, loginEncrypt: false });
      const admin = await connect(p.user, p.password);
      admins.push(admin);
      await admin.execute(`CREATE USER ${owner} IDENTIFIED BY "${password}"${kind === 'oracle' ? ' DEFAULT TABLESPACE USERS QUOTA 64M ON USERS' : ''}`);
      createdUsers.push({ admin, name: owner });
      await admin.execute(`GRANT CREATE SESSION, CREATE TABLE TO ${owner}`);
      if (kind === 'dameng') await admin.execute(`GRANT RESOURCE TO ${owner}`);
      await admin.execute(kind === 'oracle' ? `GRANT SELECT_CATALOG_ROLE TO ${owner}` : `GRANT SELECT ON DBA_SEGMENTS TO ${owner}`);
      const connection = await connect(owner, password);
      sessions.push(connection);
      console.log(kind, 'version:', (await admin.execute('SELECT * FROM V$VERSION')).rows[0][0]);
      await connection.execute(`CREATE TABLE ITEMS (PRICE NUMBER(10,2), LABEL VARCHAR2(10 CHAR), CODE CHAR(10 BYTE), N NVARCHAR2(10), CREATED DATE, PAYLOAD CLOB)`);
      await connection.execute("INSERT INTO ITEMS (PRICE,LABEL,CODE) VALUES (12.34,'中文','ok')");
      await connection.commit();
      if (kind === 'oracle') {
        await connection.execute('CREATE TABLE EMPTY_ITEMS (ID NUMBER) SEGMENT CREATION DEFERRED');
        await connection.execute('CREATE TABLE PART_ITEMS (ID NUMBER) PARTITION BY RANGE (ID) (PARTITION P1 VALUES LESS THAN (10), PARTITION P2 VALUES LESS THAN (MAXVALUE))');
        await connection.execute('INSERT INTO PART_ITEMS VALUES (1)');
        await connection.execute('INSERT INTO PART_ITEMS VALUES (11)');
        await connection.commit();
      }
      const tableCount = kind === 'oracle' ? 3 : 1;
      vi.spyOn(databaseService, 'getConnection').mockReturnValue({ db_type: kind, oracleConnection: connection, dmConnection: connection } as any);
      expect(await schemaService.collectSchema(1)).toMatchObject({ tables: tableCount });
      const initial = await schemaDatabaseService.getLatestSnapshot(1);
      const items = initial.filter(r => r.table_name === `${owner}.ITEMS`);
      const types = Object.fromEntries(items.map(r => [r.column_name, r.column_type]));
      expect(types.PRICE).toBe('NUMBER(10,2)');
      expect(types.CREATED).toBe('DATE');
      expect(types.PAYLOAD).toBe('CLOB');
      {
        expect(types.LABEL).toBe('VARCHAR2(10 CHAR)');
        expect(types.CODE).toBe('CHAR(10 BYTE)');
        expect(types.N).toBe('NVARCHAR2(10)');
      }
      const expectedSize = (await admin.execute(`SELECT SUM(BYTES) FROM DBA_SEGMENTS WHERE OWNER = '${owner}' AND SEGMENT_NAME = 'ITEMS' AND SEGMENT_TYPE = 'TABLE'`)).rows[0][0];
      expect(Number(items[0].data_length)).toBe(Number(expectedSize));
      expect(Number(expectedSize)).toBeGreaterThan(0);
      if (kind === 'oracle') {
        expect(initial.find(r => r.table_name.endsWith('.EMPTY_ITEMS'))?.data_length).toBe(0);
        const partitionBytes = (await admin.execute(`SELECT SUM(BYTES) FROM DBA_SEGMENTS WHERE OWNER = '${owner}' AND SEGMENT_NAME = 'PART_ITEMS' AND SEGMENT_TYPE = 'TABLE PARTITION'`)).rows[0][0];
        expect(Number(partitionBytes)).toBeGreaterThan(0);
        expect(Number(initial.find(r => r.table_name.endsWith('.PART_ITEMS'))?.data_length)).toBe(Number(partitionBytes));
      }
      const [previous] = await schemaDatabaseService.getSnapshotTimes(1);
      await connection.execute('ALTER TABLE ITEMS MODIFY PRICE NUMBER(12,3)');
      expect(await schemaService.collectSchema(1)).toMatchObject({ tables: tableCount });
      expect(await schemaDatabaseService.compareWithSnapshot(1, previous.snapshot_time)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'modified', column_name: 'PRICE', details: expect.objectContaining({ column_type: { old: 'NUMBER(10,2)', new: 'NUMBER(12,3)' } }) }),
      ]));
      if (kind === 'oracle') {
        // A real privilege change on this task's user exercises graceful degradation.
        await admin.execute(`REVOKE SELECT_CATALOG_ROLE FROM ${owner}`);
        await connection.execute('SET ROLE NONE');
        expect(await schemaService.collectSchema(1)).toMatchObject({ tables: tableCount });
        expect((await schemaDatabaseService.getLatestSnapshot(1)).every(r => r.data_length === null)).toBe(true);
        expect((await schemaService.getTableList(1) as any[])[0].data_length).toBeNull();
        await admin.execute(`GRANT SELECT_CATALOG_ROLE TO ${owner}`);
        await connection.execute('SET ROLE ALL');
        expect(await schemaService.collectSchema(1)).toMatchObject({ tables: tableCount });
        expect(Number((await schemaDatabaseService.getTableList(1)).find(r => r.table_name.endsWith('.ITEMS'))?.data_length)).toBe(Number(expectedSize));
      }
      console.log(kind, JSON.stringify({ types, expectedSize, persistedSize: items[0].data_length, changed: 'NUMBER(12,3)' }));
      await storage.query('DELETE FROM schema_snapshots WHERE instance_id = 1');
    }, 60000);
  }
});
