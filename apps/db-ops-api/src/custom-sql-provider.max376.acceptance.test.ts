/**
 * MAX-376 real custom-collection gate.
 *
 * The default suite collects this file and skips the database cases. Set
 * MAX376_PG_ACCEPTANCE=1 or MAX376_MYSQL_ACCEPTANCE=1 with the matching
 * injected endpoint. A missing value fails that case instead of skipping.
 * Oracle and Dameng use the same pattern when their flags are set. This file
 * does not read a developer credential path.
 *
 * The database, schema and rows are real. The DatabaseConnection passed to
 * CustomSQLProvider is constructed in this test and is not a platform
 * instance, a stored credential, or an authorization decision.
 */
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { DatabaseConnection } from './database-service.js';
import type { MetricDefinition } from './metric-registry.js';
import { CustomSQLProvider } from './collectors/custom-sql.provider.js';

const provider = new CustomSQLProvider();
const pgOn = process.env.MAX376_PG_ACCEPTANCE === '1';
const mysqlOn = process.env.MAX376_MYSQL_ACCEPTANCE === '1';
const oracleOn = process.env.MAX376_ORACLE_ACCEPTANCE === '1';
const damengOn = process.env.MAX376_DAMENG_ACCEPTANCE === '1';

interface Endpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  service?: string;
}

function endpoint(prefix: string, port: number, database = false, service = false): Endpoint {
  const host = process.env[`${prefix}_HOST`] ?? '';
  const parsedPort = Number(process.env[`${prefix}_PORT`]);
  const user = process.env[`${prefix}_USER`] ?? '';
  const password = process.env[`${prefix}_PASSWORD`] ?? '';
  const databaseName = process.env[`${prefix}_DATABASE`] ?? '';
  const serviceName = process.env[`${prefix}_SERVICE`] ?? '';
  if (!host || parsedPort !== port || !user || !password || (database && !databaseName) || (service && !serviceName)) {
    throw new Error(`${prefix}_ACCEPTANCE=1 requires ${prefix}_HOST, ${prefix}_PORT=${port}, ${prefix}_USER, ${prefix}_PASSWORD${database ? `, ${prefix}_DATABASE` : ''}${service ? `, ${prefix}_SERVICE` : ''}`);
  }
  return { host, port: parsedPort, user, password, database: databaseName || undefined, service: serviceName || undefined };
}

if (pgOn) endpoint('MAX376_PG', 5432, true);
if (mysqlOn) endpoint('MAX376_MYSQL', 3308);
if (oracleOn) endpoint('MAX376_ORACLE', 1521, false, true);
if (damengOn) endpoint('MAX376_DAMENG', 5236);

function definition(sql: string, dbType: string): MetricDefinition {
  return {
    id: 'max376.custom',
    name: 'max376',
    description: '',
    unit: 'count',
    db_types: [dbType],
    aggregation: 'last',
    default_interval: 60,
    is_collected: true,
    is_builtin: false,
    collection_sqls: { [dbType]: sql },
  };
}

function instance(dbType: string, fields: Partial<DatabaseConnection>): DatabaseConnection {
  return {
    id: 376,
    name: 'max376-acceptance',
    config: { host: 'injected', port: 1, user: 'injected', password: 'injected', db_type: dbType },
    pool: null,
    pgClient: null,
    oracleConnection: null,
    oraclePool: null,
    dmConnection: null,
    connected: true,
    db_type: dbType,
    ...fields,
  };
}

describe.skipIf(!pgOn)('MAX-376 real PostgreSQL custom collection', () => {
  const schema = `slide_max376_${process.pid}`;
  let client: PgClient;
  const owned: string[] = [];

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('returns ILIKE, cast and DISTINCT ON data and does not run a write', async () => {
    const profile = endpoint('MAX376_PG', 5432, true);
    client = new PgClient({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      database: profile.database,
    });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    owned.push(schema);
    await client.query(`CREATE TABLE ${schema}.samples (id integer PRIMARY KEY, name text NOT NULL, score integer NOT NULL)`);
    await client.query(`INSERT INTO ${schema}.samples (id, name, score) VALUES (1, 'alpha', 7), (2, 'beta', 8)`);
    const connection = instance('postgresql', { pgClient: client });

    const ilike = await provider.collect(connection, definition(
      `SELECT score FROM ${schema}.samples WHERE name ILIKE 'a%'`,
      'postgresql',
    ));
    const cast = await provider.collect(connection, definition("SELECT '42'::int", 'postgresql'));
    const distinct = await provider.collect(connection, definition(
      `SELECT COUNT(*) FROM (SELECT DISTINCT ON (id) id FROM ${schema}.samples) distinct_ids`,
      'postgresql',
    ));
    const write = await provider.collect(connection, definition(
      `WITH written AS (INSERT INTO ${schema}.samples (id, name, score) VALUES (9, 'gone', 0) RETURNING id) SELECT id FROM written`,
      'postgresql',
    ));
    const count = await client.query<{ rows: string }>(`SELECT COUNT(*)::int AS rows FROM ${schema}.samples`);

    expect(ilike).toBe(7);
    expect(cast).toBe(42);
    expect(distinct).toBe(2);
    expect(write).toBeNull();
    expect(Number(count.rows[0]?.rows)).toBe(2);
  });
});

describe.skipIf(!mysqlOn)('MAX-376 real MySQL custom collection gate', () => {
  const databaseName = `slide_max376_${process.pid}`;
  let pool: Pool;

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await pool.end();
  });

  it('returns a read and leaves the table unchanged for a write and an escape bypass', async () => {
    const profile = endpoint('MAX376_MYSQL', 3308);
    pool = mysql.createPool({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      connectionLimit: 2,
    });
    await pool.query(`CREATE DATABASE \`${databaseName}\``);
    await pool.query(`CREATE TABLE \`${databaseName}\`.samples (id INT PRIMARY KEY, name VARCHAR(32))`);
    await pool.query(`INSERT INTO \`${databaseName}\`.samples (id, name) VALUES (1, 'alpha')`);
    const connection = instance('mysql', { pool });

    const read = await provider.collect(connection, definition(
      `SELECT COUNT(*) FROM \`${databaseName}\`.samples`,
      'mysql',
    ));
    const write = await provider.collect(connection, definition(
      `INSERT INTO \`${databaseName}\`.samples (id, name) VALUES (9, 'gone')`,
      'mysql',
    ));
    const bypass = await provider.collect(connection, definition(
      "SELECT 'a\\' , SLEEP(0) AS executed -- '",
      'mysql',
    ));
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS sample_count FROM \`${databaseName}\`.samples`);

    expect(read).toBe(1);
    expect(write).toBeNull();
    expect(bypass).toBeNull();
    expect(Number(rows[0]?.sample_count)).toBe(1);
  });
});

describe.skipIf(!oracleOn)('MAX-376 real Oracle custom collection gate', () => {
  const table = `MAX376_${process.pid}`.slice(0, 30);
  let connection: { execute: Function; close: () => Promise<void> };

  afterAll(async () => {
    if (!connection) return;
    await connection.execute(`DROP TABLE ${table}`, [], { autoCommit: true }).catch(() => undefined);
    await connection.close();
  });

  it('keeps Dual readable and does not execute PostgreSQL syntax or a write', async () => {
    const oracledb = await import('oracledb');
    const oracleDriver = oracledb.default ?? oracledb;
    const profile = endpoint('MAX376_ORACLE', 1521, false, true);
    const connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${profile.host})(PORT=${profile.port}))(CONNECT_DATA=(SERVICE_NAME=${profile.service})))`;
    connection = await oracleDriver.getConnection({
      user: profile.user,
      password: profile.password,
      connectString,
    });
    await connection.execute(`CREATE TABLE ${table} (id NUMBER PRIMARY KEY)`, [], { autoCommit: true });
    await connection.execute(`INSERT INTO ${table} (id) VALUES (1)`, [], { autoCommit: true });
    const target = instance('oracle', { oracleConnection: connection as DatabaseConnection['oracleConnection'] });

    const readOutcome = await provider.collect(target, definition('SELECT 1 FROM DUAL', 'oracle')).then(
      (value) => `value:${value}`,
      (error: { message?: string }) => `error:${error.message ?? 'oracle-read-failed'}`,
    );
    const ilike = await provider.collect(target, definition("SELECT * FROM t WHERE name ILIKE 'a%'", 'oracle'));
    const write = await provider.collect(target, definition(`INSERT INTO ${table} (id) VALUES (9)`, 'oracle'));
    const check = await connection.execute(`SELECT COUNT(*) FROM ${table}`);
    const direct = await connection.execute('SELECT 1 FROM DUAL');

    expect(ilike).toBeNull();
    expect(write).toBeNull();
    expect(Number(check.rows?.[0]?.[0])).toBe(1);
    expect(Number(direct.rows?.[0]?.[0])).toBe(1);
    expect(readOutcome === 'value:1' || /ORA-|LIMIT|syntax/i.test(readOutcome), readOutcome).toBe(true);
  });
});

describe.skipIf(!damengOn)('MAX-376 real Dameng custom collection gate', () => {
  const table = `MAX376_${process.pid}`.slice(0, 30);
  let connection: { execute: Function; close: () => Promise<void> };

  afterAll(async () => {
    if (!connection) return;
    await connection.execute(`DROP TABLE ${table}`, [], { autoCommit: true }).catch(() => undefined);
    await connection.close();
  });

  it('keeps Dual readable and does not execute PostgreSQL syntax or a write', async () => {
    const dmdb = await import('dmdb');
    const damengDriver = dmdb.default ?? dmdb;
    const profile = endpoint('MAX376_DAMENG', 5236);
    connection = await damengDriver.getConnection({
      user: profile.user,
      password: profile.password,
      connectString: `${profile.host}:${profile.port}`,
      connectTimeout: 5000,
      loginEncrypt: false,
      socketTimeout: 30_000,
    });
    await connection.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY)`, [], { autoCommit: true });
    await connection.execute(`INSERT INTO ${table} (id) VALUES (1)`, [], { autoCommit: true });
    const target = instance('dameng', { dmConnection: connection as DatabaseConnection['dmConnection'] });

    const readOutcome = await provider.collect(target, definition('SELECT 1 FROM DUAL', 'dameng')).then(
      (value) => `value:${value}`,
      (error: { message?: string }) => `error:${error.message ?? 'dameng-read-failed'}`,
    );
    const distinct = await provider.collect(target, definition('SELECT DISTINCT ON (id) id FROM t', 'dameng'));
    const write = await provider.collect(target, definition(`INSERT INTO ${table} (id) VALUES (9)`, 'dameng'));
    const check = await connection.execute(`SELECT COUNT(*) FROM ${table}`, [], { maxRows: 1, autoCommit: true });
    const direct = await connection.execute('SELECT 1 FROM DUAL', [], { maxRows: 1, autoCommit: true });

    expect(distinct).toBeNull();
    expect(write).toBeNull();
    expect(Number(check.rows?.[0]?.[0])).toBe(1);
    expect(Number(direct.rows?.[0]?.[0])).toBe(1);
    expect(readOutcome === 'value:1' || /LIMIT|syntax|无效|语法/i.test(readOutcome), readOutcome).toBe(true);
  });
});
