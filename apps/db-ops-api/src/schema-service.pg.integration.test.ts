/** Opt in with MAX541_REAL=1 MAX541_PROFILES=<external JSON file>. */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection, encryptData } from './db-connection.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { schemaDatabaseService } from './schema-database-service.js';
import { schemaService } from './schema-service.js';

describe.skipIf(process.env.MAX541_REAL !== '1')('MAX-541 real PG to MySQL snapshots', () => {
  const tag = 'm541_' + randomBytes(5).toString('hex');
  const names = [tag + '_a', tag + '_b'];
  let admin: Client;
  let root: Pool;
  let storage: Pool;
  const created: string[] = [];
  let roleCreated = false;
  beforeAll(async () => {
    if (!process.env.MAX541_PROFILES) throw new Error('MAX541_PROFILES required');
    const profiles = JSON.parse(await readFile(process.env.MAX541_PROFILES, 'utf8'));
    const p = profiles['pg-test'];
    const m = profiles['mysql-test'];
    admin = new Client({ host: p.host, port: p.port, user: p.user, password: p.password, database: p.database });
    await admin.connect();
    const secret = randomBytes(16).toString('hex');
    await admin.query(`CREATE ROLE ${tag} LOGIN PASSWORD '${secret}'`);
    roleCreated = true;
    for (const name of names) {
      await admin.query(`CREATE DATABASE ${name}`);
      created.push(name);
      await admin.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${tag}`);
      const client = new Client({ host: p.host, port: p.port, user: p.user, password: p.password, database: name });
      await client.connect();
      try {
        await client.query('CREATE TABLE items(a int, b int, c int, d int, plain int, PRIMARY KEY(a,b), UNIQUE(c,d), UNIQUE(b,c), UNIQUE(a,d))');
        await client.query(`GRANT SELECT ON items TO ${tag}`);
      } finally { await client.end(); }
    }
    // Production discovery also enumerates pre-existing databases: grant our role
    // no access there, so use a catalog-filtered discovery result only. Each
    // database collection, constraints and permissions below use actual pg clients.
    const originalQuery = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: any[]) {
      if (typeof args[0] === 'string' && args[0].includes('FROM pg_database')) {
        return Promise.resolve({ rows: names.map(datname => ({ datname })) }) as any;
      }
      return originalQuery.apply(this, args as any) as any;
    });
    root = mysql.createPool({ host: m.host, port: m.port, user: m.user, password: m.password });
    await root.query(`CREATE DATABASE ${tag}`);
    storage = mysql.createPool({ host: m.host, port: m.port, user: m.user, password: m.password, database: tag });
    const ddl = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    for (const table of ['database_instances', 'schema_snapshots']) {
      const statement = ddl.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '` \\([\\s\\S]*?;'))?.[0];
      if (!statement) throw new Error('Missing DDL: ' + table);
      await storage.query(statement);
    }
    await storage.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (1,'max541','127.0.0.1',1,'fixture','fixture')");
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(storage);
    vi.spyOn(databaseService, 'getConnection').mockReturnValue({ db_type: 'postgresql', pgClient: {} } as any);
    vi.spyOn(instanceDatabaseService, 'getInstanceById').mockResolvedValue({
      host: p.host, port: p.port, username: tag, database_name: names[0], password_encrypted: encryptData(secret),
    } as any);
    console.log('PG version', (await admin.query('SHOW server_version')).rows);
  }, 30000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await storage?.end();
    if (root) { try { await root.query(`DROP DATABASE IF EXISTS ${tag}`); } finally { await root.end(); } }
    if (admin) {
      try {
        for (const name of created) await admin.query(`DROP DATABASE ${name}`);
        if (roleCreated) await admin.query(`DROP ROLE ${tag}`);
      } finally { await admin.end(); }
    }
  }, 30000);
  it('retains the complete snapshot on denied database, then recovers without false deletions', async () => {
    expect(await schemaService.collectSchema(1)).toMatchObject({ columns: 10, tables: 2 });
    const before = await schemaDatabaseService.getLatestSnapshot(1);
    const [baseline] = await schemaDatabaseService.getSnapshotTimes(1);
    expect(before).toHaveLength(10);
    for (const name of names) {
      expect(Object.fromEntries(before.filter(r => r.table_name === name + '.public.items').map(r => [r.column_name, r.column_key])))
        .toEqual({ a: 'PRI', b: 'PRI', c: 'UNI', d: 'UNI', plain: '' });
    }
    const [rowsBefore] = await storage.query('SELECT * FROM schema_snapshots ORDER BY id');
    await admin.query(`REVOKE CONNECT ON DATABASE ${names[1]} FROM ${tag}`);
    expect(await schemaService.collectSchema(1)).toEqual({ error: expect.stringContaining(names[1]) });
    expect((await storage.query('SELECT * FROM schema_snapshots ORDER BY id'))[0]).toEqual(rowsBefore);
    await admin.query(`GRANT CONNECT ON DATABASE ${names[1]} TO ${tag}`);
    expect(await schemaService.collectSchema(1)).toMatchObject({ columns: 10, tables: 2 });
    expect(await schemaDatabaseService.getLatestSnapshot(1)).toHaveLength(10);
    expect(await schemaDatabaseService.compareWithSnapshot(1, baseline.snapshot_time)).toEqual([]);
    console.log('composite keys, partial failure preservation and recovery passed');
  }, 30000);
});
